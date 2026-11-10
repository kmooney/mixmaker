declare module "soundtouchjs" {
  export class SoundTouch {
    tempo: number;
    pitch: number;
    rate: number;
  }
  export class SimpleFilter {
    constructor(source: { extract(target: Float32Array, numFrames: number, position: number): number }, pipe: SoundTouch, callback?: () => void);
    sourcePosition: number;
    extract(target: Float32Array, numFrames: number): number;
  }
}
