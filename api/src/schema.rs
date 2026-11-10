//! //SCHEMA GraphQL client and the publish choreography:
//! draft → credits → resources → uploads → publish.

use std::collections::HashSet;

use rand::Rng;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{MixMeta, MixRecord};

#[derive(Clone)]
pub struct Schema {
    pub http: reqwest::Client,
    url: String,
    key: String,
}

impl Schema {
    pub fn new(url: String, key: String) -> Self {
        Self { http: reqwest::Client::new(), url, key }
    }

    /// Runs a GraphQL operation. Field-level errors are returned alongside
    /// the data (a missing encoding should not sink a whole listing); a
    /// response with no data at all is an error.
    pub async fn gql(&self, query: &str, variables: Value) -> anyhow::Result<(Value, Vec<Value>)> {
        let res: Value = self
            .http
            .post(&self.url)
            .bearer_auth(&self.key)
            .json(&json!({ "query": query, "variables": variables }))
            .send()
            .await?
            .json()
            .await?;
        let errors = res["errors"].as_array().cloned().unwrap_or_default();
        if res["data"].is_null() {
            anyhow::bail!(
                "//SCHEMA: {}",
                errors.first().and_then(|e| e["message"].as_str()).unwrap_or("no data")
            );
        }
        Ok((res["data"].clone(), errors))
    }

    /// Like `gql`, but any error fails the call.
    async fn must(&self, query: &str, variables: Value) -> anyhow::Result<Value> {
        let (data, errors) = self.gql(query, variables).await?;
        if let Some(e) = errors.first() {
            anyhow::bail!("//SCHEMA: {}", e["message"].as_str().unwrap_or("error"));
        }
        Ok(data)
    }
}

struct Tracer {
    trace: Vec<Value>,
    warnings: Vec<String>,
}

impl Tracer {
    fn op(&self, op: &str, detail: &str) {
        tracing::info!("{op}: {detail}");
    }
    fn push(&mut self, op: &str, detail: String, ok: bool) {
        tracing::info!("{op} {detail} ok={ok}");
        self.trace.push(json!({ "op": op, "detail": detail, "ok": ok }));
    }
}

fn upc() -> String {
    // UPC-A: 11 digits + check digit. Leading 8: a prefix nothing real uses in dev.
    let mut rng = rand::thread_rng();
    let mut d: Vec<u32> = vec![8];
    d.extend((0..10).map(|_| rng.gen_range(0..10)));
    let odd: u32 = d.iter().step_by(2).sum();
    let even: u32 = d.iter().skip(1).step_by(2).sum();
    let check = (10 - (odd * 3 + even) % 10) % 10;
    d.push(check);
    d.iter().map(|x| x.to_string()).collect()
}

fn combined_pline(year: &str, remixer: &str, sources: &[Value]) -> String {
    let parts: Vec<&str> = sources.iter().filter_map(|l| l["text"].as_str()).collect();
    if parts.is_empty() {
        format!("(P) {year} {remixer} via mix-maker")
    } else {
        format!("(P) {year} {remixer} via mix-maker, incorporating {}", parts.join("; "))
    }
}

fn sha256_hex(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

const SOURCE_FIELDS: &str = r#"
  releasePk upc title
  contributors { role roleKind party { name partyPk } }
  labels { name partyPk }
  plines { value }
  clines { value }
  resources { resourcePk title isrc mediaKind contributors { role roleKind party { name partyPk } } plines { value } }
"#;

pub async fn publish(s: &Schema, meta: &MixMeta, flac: Vec<u8>, cover: Vec<u8>) -> anyhow::Result<MixRecord> {
    let mut t = Tracer { trace: vec![], warnings: vec![] };
    t.op("start", &meta.title);

    // 1. Read both sources back from the catalog — provenance comes from
    //    what //SCHEMA holds, not from what the browser claims.
    let mut sources = vec![];
    for src in &meta.sources {
        let q = format!("query($pk: Int!) {{ draftRelease(releasePk: $pk) {{ {SOURCE_FIELDS} }} }}");
        let rel = s.must(&q, json!({ "pk": src.release_pk })).await?["draftRelease"].clone();
        if rel.is_null() {
            anyhow::bail!("source release {} not found", src.release_pk);
        }
        let track = rel["resources"]
            .as_array()
            .and_then(|rs| rs.iter().find(|r| r["resourcePk"].as_i64() == Some(src.resource_pk)).cloned())
            .ok_or_else(|| anyhow::anyhow!("source track {} not found", src.resource_pk))?;
        t.push("draftRelease", format!("read source “{}” ({})", track["title"].as_str().unwrap_or("?"), rel["upc"].as_str().unwrap_or("-")), true);
        sources.push((rel, track));
    }

    // 2. The union of labels and ℗/© lines, de-duplicated, in source order.
    let mut labels = vec![];
    let mut seen_labels = HashSet::new();
    let mut plines = vec![];
    let mut clines = vec![];
    let mut seen_lines = HashSet::new();
    for (rel, _) in &sources {
        for l in rel["labels"].as_array().into_iter().flatten() {
            if let Some(pk) = l["partyPk"].as_i64() {
                if seen_labels.insert(pk) {
                    labels.push(json!({ "partyPk": pk, "isDefault": labels.is_empty() }));
                }
            }
        }
        for (key, out) in [("plines", &mut plines), ("clines", &mut clines)] {
            for line in rel[key].as_array().into_iter().flatten() {
                if let Some(v) = line["value"].as_str() {
                    if seen_lines.insert(format!("{key}{v}")) {
                        out.push(json!({ "text": v }));
                    }
                }
            }
        }
    }
    // //SCHEMA holds one ℗ and one © line per language/territory, so the
    // sources' lines are folded into a single line each rather than listed.
    let year = chrono::Utc::now().format("%Y").to_string();
    let plines = vec![json!({ "text": combined_pline(&year, &meta.remixer, &plines), "year": year })];
    let clines: Vec<Value> = if clines.is_empty() {
        vec![]
    } else {
        vec![json!({ "text": clines.iter().filter_map(|c| c["text"].as_str()).collect::<Vec<_>>().join(" / ") })]
    };

    // 3. Draft the release.
    let code = upc();
    let data = s
        .must(
            "mutation($input: CreateReleaseInput!) { createRelease(input: $input) { releasePk state } }",
            json!({ "input": { "title": meta.title, "releaseType": "Single", "upc": code, "labels": labels, "plines": plines, "clines": clines } }),
        )
        .await?;
    let release_pk = data["createRelease"]["releasePk"].as_i64().ok_or_else(|| anyhow::anyhow!("no releasePk"))?;
    t.push("createRelease", format!("draft #{release_pk}, UPC {code}, {} labels", labels.len()), true);
    t.push("createRelease", format!("℗ {}", plines[0]["text"].as_str().unwrap_or("")), true);
    if let Some(c) = clines.first() {
        t.push("createRelease", format!("© {}", c["text"].as_str().unwrap_or("")), true);
    }

    // 4. The remixer is a party of their own.
    let data = s
        .must("mutation($name: String!) { createParty(input: { name: $name }) { partyPk } }", json!({ "name": meta.remixer }))
        .await?;
    let remixer_pk = data["createParty"]["partyPk"].as_i64().unwrap_or(0);
    t.push("createParty", format!("“{}” #{remixer_pk}", meta.remixer), true);

    // 5. Release-level credits: everyone credited on either source, plus the remixer.
    let mut credits: Vec<(i64, String, String, String)> = vec![];
    let mut seen = HashSet::new();
    for (rel, _) in &sources {
        for c in rel["contributors"].as_array().into_iter().flatten() {
            let (Some(pk), Some(role)) = (c["party"]["partyPk"].as_i64(), c["role"].as_str()) else { continue };
            if seen.insert((pk, role.to_string())) {
                let kind = c["roleKind"].as_str().unwrap_or("DisplayArtistRole").to_string();
                credits.push((pk, role.to_string(), c["party"]["name"].as_str().unwrap_or("").into(), kind));
            }
        }
    }
    let credit_release = "mutation($pk: Int!, $input: CreditInput!) { creditRelease(releasePk: $pk, input: $input) { releasePk } }";
    for (i, (pk, role, name, kind)) in credits.iter().enumerate() {
        let r = s.must(credit_release, json!({ "pk": release_pk, "input": { "partyPk": pk, "role": role, "roleKind": kind, "sequence": i + 1 } })).await;
        record(&mut t, "creditRelease", format!("{name} as {role}"), r);
    }
    // `Remixer` is not a DisplayArtistRole in every AVS revision; fall back to `Artist`.
    let seq = credits.len() + 1;
    let r = s.must(credit_release, json!({ "pk": release_pk, "input": { "partyPk": remixer_pk, "role": "Remixer", "sequence": seq } })).await;
    if r.is_err() {
        let r2 = s.must(credit_release, json!({ "pk": release_pk, "input": { "partyPk": remixer_pk, "role": "Artist", "sequence": seq } })).await;
        record(&mut t, "creditRelease", format!("{} as Artist (Remixer is credited on the track)", meta.remixer), r2);
    } else {
        record(&mut t, "creditRelease", format!("{} as Remixer", meta.remixer), r);
    }

    // 6. Resources: the mixed track and its cover.
    let data = s
        .must(
            r#"mutation($pk: Int!, $title: String!, $dur: Int!) {
                track: addResource(input: { releasePk: $pk, resourceType: "MusicalWorkSoundRecording", title: $title, durationSeconds: $dur }) { resourcePk }
                cover: addResource(input: { releasePk: $pk, resourceType: "FrontCoverImage", resourceTypeKind: "ImageType" }) { resourcePk }
            }"#,
            json!({ "pk": release_pk, "title": meta.title, "dur": meta.duration_seconds }),
        )
        .await?;
    let track_pk = data["track"]["resourcePk"].as_i64().unwrap_or(0);
    let cover_pk = data["cover"]["resourcePk"].as_i64().unwrap_or(0);
    t.push("addResource", format!("track #{track_pk}, cover #{cover_pk}"), true);

    // 7. Track-level credits: every contributor on either source recording.
    let mut seen = HashSet::new();
    let credit_res = "mutation($pk: Int!, $input: CreditInput!) { creditResource(resourcePk: $pk, input: $input) { resourcePk } }";
    let mut seq = 1;
    for (_, track) in &sources {
        for c in track["contributors"].as_array().into_iter().flatten() {
            let (Some(pk), Some(role)) = (c["party"]["partyPk"].as_i64(), c["role"].as_str()) else { continue };
            if !seen.insert((pk, role.to_string())) {
                continue;
            }
            let name = c["party"]["name"].as_str().unwrap_or("");
            let kind = c["roleKind"].as_str().unwrap_or("ResourceContributorRole");
            let r = s
                .must(credit_res, json!({ "pk": track_pk, "input": { "partyPk": pk, "role": role, "roleKind": kind, "sequence": seq } }))
                .await;
            record(&mut t, "creditResource", format!("{name} as {role}"), r);
            seq += 1;
        }
    }
    let r = s
        .must(credit_res, json!({ "pk": track_pk, "input": { "partyPk": remixer_pk, "role": "Remixer", "roleKind": "ResourceContributorRole", "sequence": seq } }))
        .await;
    record(&mut t, "creditResource", format!("{} as Remixer", meta.remixer), r);

    // 8. The recording's ℗ lines: both source recordings', plus ours.
    let mut track_plines = vec![];
    let mut seen = HashSet::new();
    for (rel, track) in &sources {
        // A recording with no ℗ of its own falls under its release's.
        let own = track["plines"].as_array().is_some_and(|a| !a.is_empty());
        let lines = if own { &track["plines"] } else { &rel["plines"] };
        for line in lines.as_array().into_iter().flatten() {
            if let Some(v) = line["value"].as_str() {
                if seen.insert(v.to_string()) {
                    track_plines.push(json!({ "text": v }));
                }
            }
        }
    }
    let track_plines = vec![json!({ "text": combined_pline(&year, &meta.remixer, &track_plines), "year": year })];
    let r = s
        .must(
            "mutation($rel: Int!, $pk: Int!, $pl: [CopyrightLineInput!]) { updateResource(releasePk: $rel, resourcePk: $pk, plines: $pl) }",
            json!({ "rel": release_pk, "pk": track_pk, "pl": track_plines }),
        )
        .await;
    record(&mut t, "updateResource", format!("track ℗ {}", track_plines[0]["text"].as_str().unwrap_or("")), r);

    // 9. Bytes straight to storage, bound to their SHA-256.
    upload(s, &mut t, track_pk, &flac, "audio (FLAC)").await?;
    upload(s, &mut t, cover_pk, &cover, "cover (PNG)").await?;

    // 10. Publish.
    let data = s
        .must("mutation($pk: Int!) { publishRelease(releasePk: $pk) { published problems release { state } } }", json!({ "pk": release_pk }))
        .await?;
    let published = data["publishRelease"]["published"].as_bool().unwrap_or(false);
    let problems: Vec<String> = serde_json::from_value(data["publishRelease"]["problems"].clone()).unwrap_or_default();
    t.push("publishRelease", if published { "live".into() } else { problems.join("; ") }, published);

    let source_records = sources
        .iter()
        .map(|(rel, track)| {
            json!({
                "releasePk": rel["releasePk"], "upc": rel["upc"], "releaseTitle": rel["title"],
                "resourcePk": track["resourcePk"], "title": track["title"], "isrc": track["isrc"],
                "artists": rel["contributors"].as_array().into_iter().flatten()
                    .filter(|c| c["role"] == "MainArtist").map(|c| c["party"]["name"].clone()).collect::<Vec<_>>(),
            })
        })
        .collect();

    Ok(MixRecord {
        release_pk,
        upc: code,
        title: meta.title.clone(),
        remixer: meta.remixer.clone(),
        created_at: chrono::Utc::now(),
        published,
        problems,
        audio_resource_pk: track_pk,
        cover_resource_pk: cover_pk,
        sources: source_records,
        recipe: meta.recipe.clone(),
        trace: t.trace,
        warnings: t.warnings,
    })
}

fn record(t: &mut Tracer, op: &str, detail: String, r: anyhow::Result<Value>) {
    match r {
        Ok(_) => t.push(op, detail, true),
        Err(e) => {
            t.warnings.push(format!("{op} {detail}: {e:#}"));
            t.push(op, format!("{detail} — {e:#}"), false);
        }
    }
}

async fn upload(s: &Schema, t: &mut Tracer, resource_pk: i64, bytes: &[u8], what: &str) -> anyhow::Result<()> {
    let sha = sha256_hex(bytes);
    let data = s
        .must(
            "mutation($pk: Int!, $sha: String!, $size: Int!) { requestUpload(resourcePk: $pk, sha256: $sha, byteSize: $size) { alreadyPresent uploadUrl requiredHeaders { name value } } }",
            json!({ "pk": resource_pk, "sha": sha, "size": bytes.len() }),
        )
        .await?;
    let ticket = &data["requestUpload"];
    if ticket["alreadyPresent"].as_bool() == Some(true) {
        t.push("requestUpload", format!("{what}: already present (dedup by content hash)"), true);
    } else {
        let url = ticket["uploadUrl"].as_str().ok_or_else(|| anyhow::anyhow!("no uploadUrl"))?;
        let mut req = s.http.put(url).body(bytes.to_vec());
        for h in ticket["requiredHeaders"].as_array().into_iter().flatten() {
            req = req.header(h["name"].as_str().unwrap_or(""), h["value"].as_str().unwrap_or(""));
        }
        let res = req.send().await?;
        if !res.status().is_success() {
            let st = res.status();
            anyhow::bail!("upload of {what} failed: {st} {}", res.text().await.unwrap_or_default());
        }
        t.push("requestUpload", format!("{what}: PUT {} bytes, sha256 {}…", bytes.len(), &sha[..12]), true);
    }
    s.must(
        "mutation($pk: Int!, $sha: String!) { completeUpload(resourcePk: $pk, sha256: $sha) { state } }",
        json!({ "pk": resource_pk, "sha": sha }),
    )
    .await?;
    t.push("completeUpload", format!("{what}: stored"), true);
    Ok(())
}
