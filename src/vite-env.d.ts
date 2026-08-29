/// <reference types="vite/client" />

declare module "@ffmpeg/core?url" {
  const url: string;
  export default url;
}

declare module "@ffmpeg/core/wasm?url" {
  const url: string;
  export default url;
}

declare module "@ffmpeg/ffmpeg/worker?url" {
  const url: string;
  export default url;
}
