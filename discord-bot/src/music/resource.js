// Turns a library track into something @discordjs/voice can play. Local files go straight through
// ffmpeg; radio streams get a reconnecting ffmpeg so a network hiccup does not end the stream.

import { createAudioResource, StreamType } from '@discordjs/voice';
import prism from 'prism-media';

// prism-media's Opus encoder nulls its buffer when destroyed. If a stream is destroyed while it is
// still encoding (a 'data' listener that stops the track, or a queued write arriving late), the next
// loop turn throws an uncaught TypeError and takes the whole bot down. Swallow errors only from
// streams that are already destroyed; anything else still throws.
const encode = prism.opus.Encoder.prototype._transform;
prism.opus.Encoder.prototype._transform = function guarded(chunk, encoding, done) {
  try {
    return encode.call(this, chunk, encoding, done);
  } catch (err) {
    if (this.destroyed || this._buffer === null) return done();
    throw err;
  }
};

export function makeResource(track, volume = 0.5) {
  let resource;
  if (track.kind === 'radio') {
    const ffmpeg = new prism.FFmpeg({
      args: ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-i', track.url, '-analyzeduration', '0', '-loglevel', '0', '-f', 's16le', '-ar', '48000', '-ac', '2'],
    });
    resource = createAudioResource(ffmpeg, { inputType: StreamType.Raw, inlineVolume: true });
    resource.playStream.on('close', () => ffmpeg.destroy());
  } else {
    resource = createAudioResource(track.file, { inlineVolume: true });
  }
  resource.volume?.setVolume(volume);
  return resource;
}
