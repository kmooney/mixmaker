//! mix-maker API: a thin axum service in front of //SCHEMA.
//!
//! - lists playable tracks from the catalog (with every credit attached)
//! - proxies media so the browser never sees the API key or a signed URL
//! - runs demucs stem separation on demand
//! - publishes a finished mix back into //SCHEMA as a new release whose
//!   credits, labels and ℗/© lines are the union of both sources, and keeps a
//!   provenance record linking the new release to the exact source recordings.

mod schema;

use std::{
    collections::HashMap,
    path::{Path as FsPath, PathBuf},
    sync::Arc,
};

use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Multipart, Path, Query, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Mutex;
use tower_http::{
    cors::CorsLayer,
    services::{ServeDir, ServeFile},
};

use schema::Schema;

#[derive(Clone)]
struct AppState {
    schema: Schema,
    data: PathBuf,
    python: PathBuf,
    stems: Arc<Mutex<HashMap<i64, StemJob>>>,
    mixes_lock: Arc<Mutex<()>>,
    /// The full track list, served stale-while-revalidate: listing the whole
    /// catalog with encodings costs //SCHEMA ~1–2s, and it changes slowly.
    tracks_cache: Arc<Mutex<Option<(std::time::Instant, Value)>>>,
    tracks_refreshing: Arc<std::sync::atomic::AtomicBool>,
    /// One demucs at a time: concurrent runs on one GPU are slower than queued ones.
    gpu: Arc<tokio::sync::Semaphore>,
    /// Estimated tempo per resource, persisted to `data/bpm.json`. `None` means
    /// measured and no tempo found; an absent key means not measured yet.
    bpm: Arc<Mutex<HashMap<i64, Option<u32>>>>,
    bpm_running: Arc<std::sync::atomic::AtomicBool>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
enum StemJob {
    Running { started: chrono::DateTime<chrono::Utc> },
    Done { stems: Vec<StemFile> },
    Error { message: String },
}

#[derive(Clone, Serialize)]
struct StemFile {
    name: String,
    url: String,
}

struct ApiError(anyhow::Error);
impl<E: Into<anyhow::Error>> From<E> for ApiError {
    fn from(e: E) -> Self {
        ApiError(e.into())
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        tracing::error!("{:#}", self.0);
        (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": format!("{:#}", self.0) })),
        )
            .into_response()
    }
}
type ApiResult<T> = Result<T, ApiError>;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let root = std::env::current_dir()?;
    // .env lives at the repo root; allow running from either root or api/.
    let _ = dotenvy::from_path(root.join(".env")).or_else(|_| dotenvy::from_path(root.join("../.env")));
    tracing_subscriber::fmt()
        .with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "mix_maker_api=info".into()))
        .init();

    let project = if root.join("api").exists() { root.clone() } else { root.join("..") };
    let data = project.join("data");
    tokio::fs::create_dir_all(data.join("cache")).await?;
    tokio::fs::create_dir_all(data.join("stems")).await?;

    let state = AppState {
        schema: Schema::new(
            std::env::var("SCHEMA_API_URL").unwrap_or_else(|_| "https://api.schema.fm/graphql".into()),
            std::env::var("SCHEMA_API_KEY").map_err(|_| anyhow::anyhow!("SCHEMA_API_KEY is not set"))?,
        ),
        python: std::env::var("DEMUCS_PYTHON")
            .map(PathBuf::from)
            .unwrap_or_else(|_| project.join(".venv/bin/python")),
        data: data.clone(),
        stems: Default::default(),
        mixes_lock: Default::default(),
        tracks_cache: Default::default(),
        tracks_refreshing: Default::default(),
        gpu: Arc::new(tokio::sync::Semaphore::new(1)),
        bpm: Arc::new(Mutex::new(load_bpm(&data).await)),
        bpm_running: Default::default(),
    };
    {
        // Warm the track list so the first page load doesn't pay for it, then
        // start measuring tempos for whatever is missing one.
        let st = state.clone();
        tokio::spawn(async move {
            if let Ok(v) = fetch_tracks(&st, None).await {
                *st.tracks_cache.lock().await = Some((std::time::Instant::now(), v));
                kick_bpm(&st);
            }
        });
    }

    let dist = project.join("web/dist");
    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/tracks", get(list_tracks))
        .route("/api/media/{release_pk}/{resource_pk}", get(media))
        .route("/api/stems/{release_pk}/{resource_pk}", post(start_stems).get(stem_status))
        .route("/api/mixes", get(list_mixes).post(publish_mix))
        .nest_service("/files", ServeDir::new(&data))
        .fallback_service(ServeDir::new(&dist).fallback(ServeFile::new(dist.join("index.html"))))
        .layer(DefaultBodyLimit::max(512 * 1024 * 1024))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let bind = std::env::var("MIXMAKER_BIND").unwrap_or_else(|_| "127.0.0.1:8090".into());
    tracing::info!("mix-maker api on http://{bind}");
    axum::serve(tokio::net::TcpListener::bind(&bind).await?, app).await?;
    Ok(())
}

async fn health(State(s): State<AppState>) -> ApiResult<Json<Value>> {
    let (data, _) = s.schema.gql("{ viewer { catalogPk scopes } }", json!({})).await?;
    let demucs = s.python.exists();
    Ok(Json(json!({ "schema": data["viewer"], "demucs": demucs })))
}

// ---------------------------------------------------------------- tracks

const RELEASE_FIELDS: &str = r#"
  releasePk upc title state
  contributors { role party { name partyPk } }
  labels { name partyPk }
  plines { value }
  clines { value }
  resources {
    resourcePk title isrc durationSeconds resourceType mediaKind state
    contributors { role party { name partyPk } }
    plines { value }
    encodings { encoding clip { startMs } }
  }
"#;

#[derive(Deserialize)]
struct TrackQuery {
    q: Option<String>,
}

const TRACKS_FRESH: std::time::Duration = std::time::Duration::from_secs(20);

async fn list_tracks(State(s): State<AppState>, Query(tq): Query<TrackQuery>) -> ApiResult<Json<Value>> {
    let q = tq.q.filter(|q| !q.trim().is_empty());
    if q.is_some() {
        let v = fetch_tracks(&s, q).await?;
        return Ok(Json(with_bpm(&s, v).await));
    }
    // Cheap when a pass is already running or nothing is missing.
    kick_bpm(&s);
    let cached = s.tracks_cache.lock().await.clone();
    if let Some((at, v)) = cached {
        // Stale: answer now, refresh behind the response (one refresh at a time).
        if at.elapsed() > TRACKS_FRESH && !s.tracks_refreshing.swap(true, std::sync::atomic::Ordering::SeqCst) {
            let st = s.clone();
            tokio::spawn(async move {
                if let Ok(v) = fetch_tracks(&st, None).await {
                    *st.tracks_cache.lock().await = Some((std::time::Instant::now(), v));
                }
                st.tracks_refreshing.store(false, std::sync::atomic::Ordering::SeqCst);
            });
        }
        return Ok(Json(with_bpm(&s, v).await));
    }
    let v = fetch_tracks(&s, None).await?;
    *s.tracks_cache.lock().await = Some((std::time::Instant::now(), v.clone()));
    Ok(Json(with_bpm(&s, v).await))
}

async fn fetch_tracks(s: &AppState, q: Option<String>) -> anyhow::Result<Value> {
    let query = format!("query($q: String) {{ releases(limit: 200, q: $q) {{ {RELEASE_FIELDS} }} }}");
    let (data, _) = s.schema.gql(&query, json!({ "q": q })).await?;
    let mixes = load_mixes(&s.data).await;
    let mixed_pks: Vec<i64> = mixes.iter().map(|m| m.release_pk).collect();

    let mut tracks = vec![];
    for rel in data["releases"].as_array().cloned().unwrap_or_default() {
        let resources = rel["resources"].as_array().cloned().unwrap_or_default();
        let cover = resources.iter().find(|r| r["mediaKind"] == "IMAGE" && r["state"] == "stored");
        for r in resources.iter().filter(|r| r["mediaKind"] == "AUDIO" && r["state"] == "stored") {
            tracks.push(track_json(&rel, r, cover, mixed_pks.contains(&rel["releasePk"].as_i64().unwrap_or(0))));
        }
    }
    Ok(json!({ "tracks": tracks }))
}

fn track_json(rel: &Value, r: &Value, cover: Option<&Value>, is_mix: bool) -> Value {
    let release_pk = rel["releasePk"].as_i64().unwrap_or(0);
    let artists: Vec<Value> = rel["contributors"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| c["role"] == "MainArtist" || c["role"] == "DisplayArtist" || c["role"] == "Artist")
        .map(|c| c["party"]["name"].clone())
        .collect();
    json!({
        "id": format!("{}-{}", release_pk, r["resourcePk"]),
        "releasePk": release_pk,
        "resourcePk": r["resourcePk"],
        "upc": rel["upc"],
        "releaseTitle": rel["title"],
        "title": r["title"].as_str().or(rel["title"].as_str()),
        "isrc": r["isrc"],
        "durationSeconds": r["durationSeconds"],
        "artists": artists,
        "releaseContributors": rel["contributors"],
        "trackContributors": r["contributors"],
        "labels": rel["labels"],
        "plines": rel["plines"],
        "clines": rel["clines"],
        "trackPlines": r["plines"],
        "audioUrl": format!("/api/media/{}/{}", release_pk, r["resourcePk"]),
        "coverUrl": cover.map(|c| format!("/api/media/{}/{}", release_pk, c["resourcePk"])),
        "isMix": is_mix,
        "playable": r["encodings"].as_array().into_iter().flatten()
            .any(|e| e["clip"].is_null() && e["encoding"].as_str().is_some_and(|x| x.starts_with("aac-"))),
    })
}

// ---------------------------------------------------------------- media

/// Fetches a resource's bytes through a freshly minted signed URL and caches
/// them on disk. Audio prefers the AAC stream encodings (what a `media_read`
/// key reaches); images use their original.
async fn fetch_media(s: &AppState, release_pk: i64, resource_pk: i64) -> anyhow::Result<(PathBuf, String)> {
    let cache = s.data.join("cache");
    for (ext, ct) in [("m4a", "audio/mp4"), ("img", "image/jpeg")] {
        let p = cache.join(format!("{resource_pk}.{ext}"));
        if tokio::fs::try_exists(&p).await.unwrap_or(false) {
            return Ok((p, ct.into()));
        }
    }
    let q = "query($pk: Int!) { draftRelease(releasePk: $pk) { resources { resourcePk mediaKind } } }";
    let (data, _) = s.schema.gql(q, json!({ "pk": release_pk })).await?;
    let res = data["draftRelease"]["resources"]
        .as_array()
        .and_then(|rs| rs.iter().find(|r| r["resourcePk"].as_i64() == Some(resource_pk)).cloned())
        .ok_or_else(|| anyhow::anyhow!("resource {resource_pk} not in release {release_pk}"))?;
    let is_image = res["mediaKind"] == "IMAGE";
    let candidates: &[&str] = if is_image { &["original"] } else { &["aac-256", "aac-128", "original"] };

    let mut last_err = String::new();
    for enc in candidates {
        let q = "query($pk: Int!, $enc: String!) { draftRelease(releasePk: $pk) { resources { resourcePk url(encoding: $enc, ttlSeconds: 600) } } }";
        let (data, errors) = s.schema.gql(q, json!({ "pk": release_pk, "enc": enc })).await?;
        let url = data["draftRelease"]["resources"]
            .as_array()
            .and_then(|rs| rs.iter().find(|r| r["resourcePk"].as_i64() == Some(resource_pk)))
            .and_then(|r| r["url"].as_str().map(String::from));
        let Some(url) = url else {
            last_err = format!("{enc}: {}", errors.first().and_then(|e| e["message"].as_str()).unwrap_or("no url"));
            continue;
        };
        let bytes = s.schema.http.get(&url).send().await?.error_for_status()?.bytes().await?;
        let (ext, ct) = if is_image {
            ("img", if bytes.starts_with(b"\x89PNG") { "image/png" } else { "image/jpeg" })
        } else {
            ("m4a", "audio/mp4")
        };
        let p = cache.join(format!("{resource_pk}.{ext}"));
        tokio::fs::write(&p, &bytes).await?;
        return Ok((p, ct.into()));
    }
    // A mix we just published plays from our own render until //SCHEMA's
    // encoder has made its AAC.
    let local = cache.join(format!("{resource_pk}.flac"));
    if tokio::fs::try_exists(&local).await.unwrap_or(false) {
        return Ok((local, "audio/flac".into()));
    }
    anyhow::bail!("no playable encoding for resource {resource_pk} ({last_err})")
}

#[derive(Deserialize)]
struct MediaQuery {
    /// Thumbnail width for images; the original is 1400px and several MB.
    w: Option<u32>,
}

async fn media(
    State(s): State<AppState>,
    Path((release_pk, resource_pk)): Path<(i64, i64)>,
    Query(mq): Query<MediaQuery>,
) -> ApiResult<Response> {
    let (path, ct) = fetch_media(&s, release_pk, resource_pk).await?;
    if let (true, Some(w)) = (ct.starts_with("image"), mq.w) {
        let w = w.clamp(64, 1400);
        let thumb = s.data.join("cache").join(format!("{resource_pk}.w{w}.jpg"));
        if !tokio::fs::try_exists(&thumb).await.unwrap_or(false) {
            let (src, dst) = (path.to_string_lossy().to_string(), thumb.to_string_lossy().to_string());
            let scale = format!("scale={w}:-2");
            run("ffmpeg", &["-y", "-loglevel", "error", "-i", &src, "-vf", &scale, "-q:v", "3", &dst]).await?;
        }
        let bytes = tokio::fs::read(&thumb).await?;
        return Ok((
            [(header::CONTENT_TYPE, "image/jpeg".to_string()), (header::CACHE_CONTROL, "public, max-age=86400".into())],
            Body::from(bytes),
        )
            .into_response());
    }
    let bytes = tokio::fs::read(&path).await?;
    let ct = if ct.starts_with("image") && bytes.starts_with(b"\x89PNG") { "image/png".to_string() } else { ct };
    Ok(([(header::CONTENT_TYPE, ct), (header::CACHE_CONTROL, "public, max-age=3600".into())], Body::from(bytes))
        .into_response())
}

// ---------------------------------------------------------------- bpm
//
// Tempo is measured here, once per track, so the picker can search by it
// before a track is loaded. It is mix-maker's own estimate, not catalog data:
// //SCHEMA has no tempo field, and these numbers live only in `data/bpm.json`.
//
// The estimator is a port of the browser's `estimateBpm` (web/src/audio.ts),
// fed the same samples. It still cannot agree with the browser exactly: the
// browser decodes at its AudioContext's rate (often 48 kHz), and the estimate
// is sensitive to that. So a deck uses this value when there is one, and the
// browser's own estimate only for a track not measured yet.

/// The tempo attached at answer time rather than baked into the cached list,
/// so a value measured a second ago shows on the next poll. `bpm` is absent
/// until measured and `null` when measured without a result, which is how the
/// picker counts what is still to come.
async fn with_bpm(s: &AppState, mut v: Value) -> Value {
    let bpm = s.bpm.lock().await;
    for t in v["tracks"].as_array_mut().into_iter().flatten() {
        let pk = t["resourcePk"].as_i64().unwrap_or(0);
        if let Some(b) = bpm.get(&pk) {
            t["bpm"] = json!(b);
        }
    }
    v
}

async fn load_bpm(data: &FsPath) -> HashMap<i64, Option<u32>> {
    let Ok(b) = tokio::fs::read(data.join("bpm.json")).await else { return HashMap::new() };
    let raw: HashMap<String, Option<u32>> = serde_json::from_slice(&b).unwrap_or_default();
    raw.into_iter().filter_map(|(k, v)| Some((k.parse().ok()?, v))).collect()
}

async fn save_bpm(s: &AppState) -> anyhow::Result<()> {
    let raw: HashMap<String, Option<u32>> =
        s.bpm.lock().await.iter().map(|(k, v)| (k.to_string(), *v)).collect();
    let tmp = s.data.join("bpm.json.tmp");
    tokio::fs::write(&tmp, serde_json::to_vec_pretty(&raw)?).await?;
    tokio::fs::rename(&tmp, s.data.join("bpm.json")).await?;
    Ok(())
}

/// Starts a background pass over playable tracks with no tempo yet, unless one
/// is already running. One track at a time: each pass downloads audio, and it
/// should never compete with someone actually loading a deck.
fn kick_bpm(s: &AppState) {
    use std::sync::atomic::Ordering::SeqCst;
    if s.bpm_running.swap(true, SeqCst) {
        return;
    }
    let st = s.clone();
    tokio::spawn(async move {
        let tracks = st.tracks_cache.lock().await.as_ref().map(|(_, v)| v["tracks"].clone());
        let todo: Vec<(i64, i64)> = {
            let known = st.bpm.lock().await;
            tracks
                .as_ref()
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|t| t["playable"] == true)
                .filter_map(|t| {
                    let pk = t["resourcePk"].as_i64()?;
                    (!known.contains_key(&pk)).then(|| (t["releasePk"].as_i64().unwrap_or(0), pk))
                })
                .collect()
        };
        if !todo.is_empty() {
            tracing::info!("measuring tempo for {} tracks", todo.len());
        }
        for (release_pk, resource_pk) in todo {
            match measure_bpm(&st, release_pk, resource_pk).await {
                Ok(bpm) => {
                    st.bpm.lock().await.insert(resource_pk, bpm);
                    if let Err(e) = save_bpm(&st).await {
                        tracing::warn!("saving bpm.json: {e:#}");
                    }
                }
                // Not recorded: a failed download is retried on the next pass,
                // and only "measured, no tempo" is remembered as `None`.
                Err(e) => tracing::warn!("tempo for {resource_pk}: {e:#}"),
            }
        }
        st.bpm_running.store(false, SeqCst);
    });
}

async fn measure_bpm(s: &AppState, release_pk: i64, resource_pk: i64) -> anyhow::Result<Option<u32>> {
    const SR: u32 = 44100;
    let (src, _) = fetch_media(s, release_pk, resource_pk).await?;
    // The whole track, first channel only: exactly what the browser hands
    // `estimateBpm` (`getChannelData(0)` of the decoded file). Seeking in
    // ffmpeg or downmixing instead measurably moved the estimate. `c0=c0`,
    // not `c0=FL`: a mono source has no FL, and naming it decodes silence.
    let out = tokio::process::Command::new("ffmpeg")
        .args(["-nostdin", "-loglevel", "error", "-i"])
        .arg(&src)
        .args(["-af", "pan=mono|c0=c0", "-ar", &SR.to_string(), "-f", "f32le", "-"])
        .output()
        .await?;
    if !out.status.success() {
        anyhow::bail!("ffmpeg: {}", String::from_utf8_lossy(&out.stderr).trim());
    }
    let samples: Vec<f32> =
        out.stdout.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    Ok(estimate_bpm(&samples, SR as f64))
}

/// Onset-energy autocorrelation over 70–180 BPM, on 30 seconds starting at
/// min(30s, a quarter of the way in). Keep in step with `estimateBpm` in
/// web/src/audio.ts.
fn estimate_bpm(data: &[f32], sr: f64) -> Option<u32> {
    const HOP: usize = 512;
    let duration = data.len() as f64 / sr;
    let start = ((duration / 4.0).min(30.0) * sr).floor() as usize;
    let end = data.len().min(start + (30.0 * sr) as usize);
    let mut env = vec![];
    let mut prev = 0.0f64;
    let mut i = start;
    while i + HOP < end {
        let e: f64 = data[i..i + HOP].iter().map(|x| (*x as f64) * (*x as f64)).sum();
        env.push((e - prev).max(0.0));
        prev = e;
        i += HOP;
    }
    if env.len() < 100 {
        return None;
    }
    let fps = sr / HOP as f64;
    let (mut best, mut best_lag) = (0.0f64, 0.0f64);
    let mut bpm = 70.0;
    while bpm <= 180.0 {
        let lag = 60.0 / bpm * fps;
        let mut s = 0.0;
        let mut i = 0usize;
        while (i as f64) + lag < env.len() as f64 {
            s += env[i] * env[(i as f64 + lag).floor() as usize];
            i += 1;
        }
        if s > best {
            best = s;
            best_lag = lag;
        }
        bpm += 0.5;
    }
    (best_lag > 0.0).then(|| (60.0 * fps / best_lag).round() as u32)
}

// ---------------------------------------------------------------- stems

const STEM_NAMES: [&str; 4] = ["vocals", "drums", "bass", "other"];

fn stem_dir(data: &FsPath, resource_pk: i64) -> PathBuf {
    data.join("stems").join(resource_pk.to_string())
}

fn finished_stems(data: &FsPath, resource_pk: i64) -> Option<Vec<StemFile>> {
    let dir = stem_dir(data, resource_pk).join("htdemucs").join("input");
    let mut out = vec![];
    for name in STEM_NAMES {
        let ext = ["flac", "mp3", "wav"].into_iter().find(|e| dir.join(format!("{name}.{e}")).exists())?;
        out.push(StemFile {
            name: name.into(),
            url: format!("/files/stems/{resource_pk}/htdemucs/input/{name}.{ext}"),
        });
    }
    Some(out)
}

async fn stem_status(State(s): State<AppState>, Path((_r, resource_pk)): Path<(i64, i64)>) -> Json<Value> {
    // demucs writes stems one by one; only trust the files once the job has ended.
    if let Some(job @ StemJob::Running { .. }) = s.stems.lock().await.get(&resource_pk) {
        return Json(serde_json::to_value(job).unwrap());
    }
    if let Some(stems) = finished_stems(&s.data, resource_pk) {
        return Json(serde_json::to_value(StemJob::Done { stems }).unwrap());
    }
    match s.stems.lock().await.get(&resource_pk) {
        Some(job) => Json(serde_json::to_value(job).unwrap()),
        None => Json(json!({ "status": "none" })),
    }
}

async fn start_stems(State(s): State<AppState>, Path((release_pk, resource_pk)): Path<(i64, i64)>) -> Json<Value> {
    {
        let mut jobs = s.stems.lock().await;
        if let Some(job @ StemJob::Running { .. }) = jobs.get(&resource_pk) {
            return Json(serde_json::to_value(job).unwrap());
        }
        if let Some(stems) = finished_stems(&s.data, resource_pk) {
            return Json(serde_json::to_value(StemJob::Done { stems }).unwrap());
        }
        jobs.insert(resource_pk, StemJob::Running { started: chrono::Utc::now() });
    }
    let st = s.clone();
    tokio::spawn(async move {
        let result = separate(&st, release_pk, resource_pk).await;
        let job = match result {
            Ok(stems) => StemJob::Done { stems },
            Err(e) => {
                tracing::error!("stems for {resource_pk}: {e:#}");
                StemJob::Error { message: format!("{e:#}") }
            }
        };
        st.stems.lock().await.insert(resource_pk, job);
    });
    Json(json!({ "status": "running" }))
}

async fn separate(s: &AppState, release_pk: i64, resource_pk: i64) -> anyhow::Result<Vec<StemFile>> {
    let (src, _) = fetch_media(s, release_pk, resource_pk).await?;
    let dir = stem_dir(&s.data, resource_pk);
    let _ = tokio::fs::remove_dir_all(dir.join("htdemucs")).await;
    tokio::fs::create_dir_all(&dir).await?;
    let wav = dir.join("input.wav");
    let (srcs, wavs) = (src.to_string_lossy().to_string(), wav.to_string_lossy().to_string());
    run("ffmpeg", &["-y", "-loglevel", "error", "-i", &srcs, "-ar", "44100", "-ac", "2", &wavs]).await?;

    let py = s.python.to_string_lossy().to_string();
    let out = dir.to_string_lossy().to_string();
    let w = wav.to_string_lossy().to_string();
    // FLAC, not MP3: demucs's MP3 encoder is single-threaded and took longer
    // than the separation itself (benchmarked: 55s vs 79s+ for a 200s track).
    let _gpu = s.gpu.acquire().await?;
    // Apple silicon first; plain CPU if MPS is unavailable.
    let mps = run(&py, &["-m", "demucs", "-n", "htdemucs", "--flac", "-d", "mps", "-o", &out, &w]).await;
    if let Err(e) = mps {
        tracing::warn!("demucs on mps failed, retrying on cpu: {e:#}");
        run(&py, &["-m", "demucs", "-n", "htdemucs", "--flac", "-d", "cpu", "-o", &out, &w]).await?;
    }
    finished_stems(&s.data, resource_pk).ok_or_else(|| anyhow::anyhow!("demucs produced no stems"))
}

async fn run(cmd: &str, args: &[&str]) -> anyhow::Result<()> {
    let out = tokio::process::Command::new(cmd).args(args).output().await?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let tail: String = err.chars().rev().take(800).collect::<String>().chars().rev().collect();
        anyhow::bail!("{cmd} failed: {tail}");
    }
    Ok(())
}

// ---------------------------------------------------------------- mixes

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MixRecord {
    release_pk: i64,
    upc: String,
    title: String,
    remixer: String,
    created_at: chrono::DateTime<chrono::Utc>,
    published: bool,
    problems: Vec<String>,
    audio_resource_pk: i64,
    cover_resource_pk: i64,
    /// The exact recordings this mix was cut from.
    sources: Vec<Value>,
    /// What the user did: stem levels, tempo, offsets, crossfade.
    recipe: Value,
    /// Every //SCHEMA operation that built the release, in order.
    trace: Vec<Value>,
    warnings: Vec<String>,
}

async fn load_mixes(data: &FsPath) -> Vec<MixRecord> {
    match tokio::fs::read(data.join("mixes.json")).await {
        Ok(b) => serde_json::from_slice(&b).unwrap_or_default(),
        Err(_) => vec![],
    }
}

async fn list_mixes(State(s): State<AppState>) -> ApiResult<Json<Value>> {
    let mixes = load_mixes(&s.data).await;
    // Read every release back from //SCHEMA (what's shown is what the
    // catalog holds), all at once rather than one after another.
    let mut set = tokio::task::JoinSet::new();
    for (i, m) in mixes.iter().rev().cloned().enumerate() {
        let st = s.clone();
        set.spawn(async move {
            let q = format!("query($pk: Int!) {{ draftRelease(releasePk: $pk) {{ {RELEASE_FIELDS} }} }}");
            let live = st.schema.gql(&q, json!({ "pk": m.release_pk })).await.map(|(d, _)| d["draftRelease"].clone()).unwrap_or(Value::Null);
            (i, m, live)
        });
    }
    let mut rows = set.join_all().await;
    rows.sort_by_key(|(i, _, _)| *i);
    let mut out = vec![];
    for (_, m, live) in rows {
        let mut v = serde_json::to_value(&m)?;
        v["release"] = live;
        v["audioUrl"] = json!(format!("/api/media/{}/{}", m.release_pk, m.audio_resource_pk));
        v["coverUrl"] = json!(format!("/api/media/{}/{}", m.release_pk, m.cover_resource_pk));
        out.push(v);
    }
    Ok(Json(json!({ "mixes": out })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MixMeta {
    title: String,
    remixer: String,
    duration_seconds: i64,
    sources: Vec<SourceRef>,
    #[serde(default)]
    recipe: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceRef {
    release_pk: i64,
    resource_pk: i64,
}

async fn publish_mix(State(s): State<AppState>, mut mp: Multipart) -> ApiResult<Json<Value>> {
    let (mut meta, mut audio, mut cover) = (None, None, None);
    while let Some(field) = mp.next_field().await? {
        match field.name().unwrap_or("") {
            "meta" => meta = Some(serde_json::from_slice::<MixMeta>(&field.bytes().await?)?),
            "audio" => audio = Some(field.bytes().await?),
            "cover" => cover = Some(field.bytes().await?),
            _ => {}
        }
    }
    let meta = meta.ok_or_else(|| anyhow::anyhow!("missing meta"))?;
    let audio = audio.ok_or_else(|| anyhow::anyhow!("missing audio"))?;
    let cover = cover.ok_or_else(|| anyhow::anyhow!("missing cover"))?;

    // //SCHEMA refuses lossy masters, and the browser renders WAV: store FLAC.
    let work = s.data.join("work").join(chrono::Utc::now().timestamp_millis().to_string());
    tokio::fs::create_dir_all(&work).await?;
    let wav = work.join("mix.wav");
    let flac = work.join("mix.flac");
    tokio::fs::write(&wav, &audio).await?;
    let (wavs, flacs) = (wav.to_string_lossy().to_string(), flac.to_string_lossy().to_string());
    run("ffmpeg", &["-y", "-loglevel", "error", "-i", &wavs, "-c:a", "flac", &flacs]).await?;
    let flac_bytes = tokio::fs::read(&flac).await?;

    let rec = schema::publish(&s.schema, &meta, flac_bytes.clone(), cover.to_vec()).await?;
    let cache = s.data.join("cache");
    tokio::fs::write(cache.join(format!("{}.flac", rec.audio_resource_pk)), &flac_bytes).await?;
    tokio::fs::write(cache.join(format!("{}.img", rec.cover_resource_pk)), &cover).await?;

    let _g = s.mixes_lock.lock().await;
    let mut mixes = load_mixes(&s.data).await;
    mixes.push(rec.clone());
    tokio::fs::write(s.data.join("mixes.json"), serde_json::to_vec_pretty(&mixes)?).await?;
    // The new release belongs in the next track list.
    *s.tracks_cache.lock().await = None;
    let _ = tokio::fs::remove_dir_all(&work).await;
    Ok(Json(serde_json::to_value(rec)?))
}
