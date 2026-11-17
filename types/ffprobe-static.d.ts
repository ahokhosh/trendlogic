// ffprobe-static ships no TypeScript types (unlike ffmpeg-static which has
// its own). Mirror its real CJS export shape: `exports.path = <binary path>`.
declare module 'ffprobe-static' {
  const ffprobeStatic: { path: string };
  export default ffprobeStatic;
}
