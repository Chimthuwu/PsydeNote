import type { CaptureSource } from '../../shared/types';

/**
 * Wraps Electron's desktopCapturer API to obtain a MediaStream whose audio
 * tracks carry the system/loopback audio of the picked screen or window.
 *
 * On Windows, desktopCapturer uses the platform's screen-capture backend and
 * yields a stream with both video (we discard) and audio. Combined with
 * Chromium's loopback audio mixer this is the closest analogue to a true
 * WASAPI loopback without the need for a native build step.
 */
export async function pickSourceAndCapture(
  sourceId: string,
): Promise<MediaStream | null> {
  const source: MediaStream | null = await (navigator.mediaDevices as any).getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
      },
    },
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
      },
    },
  });

  if (source) {
    // We only want audio, so stop and remove the video tracks immediately
    // Requesting video was mandatory to prevent Chromium IPC crashes.
    source.getVideoTracks().forEach(track => {
      track.stop();
      source.removeTrack(track);
    });
  }

  return source;
}

export async function listSources(): Promise<CaptureSource[]> {
  return window.api.listSources();
}
