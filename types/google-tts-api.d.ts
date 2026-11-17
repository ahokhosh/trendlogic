// google-tts-api ships no TypeScript types. Minimal shape covering what the
// renderers use (getAllAudioBase64), compatible with both
// `import googleTTS from 'google-tts-api'` and `import * as googleTTS`.
declare module 'google-tts-api' {
  export interface TtsOptions {
    lang?: string;
    slow?: boolean;
    timeout?: number;
  }
  export interface TtsAudioChunk {
    base64: string;
  }
  export function getAllAudioBase64(
    text: string,
    options?: TtsOptions
  ): Promise<TtsAudioChunk[]>;
  export function getAudioBase64(
    text: string,
    options?: TtsOptions
  ): Promise<string>;
  const _default: {
    getAllAudioBase64: typeof getAllAudioBase64;
    getAudioBase64: typeof getAudioBase64;
  };
  export default _default;
}
