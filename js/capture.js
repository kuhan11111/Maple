// Wraps the hidden <video> that supplies frames: screen/window share, or a video file
// (handy for trying the detector on a recording).

export class Capture {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.url = null;
    this.onEnded = null;
  }

  get active() {
    return this.video.readyState >= 2 && this.video.videoWidth > 0;
  }

  async startScreen() {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
    await this.useStream(stream);
  }

  async useStream(stream) {
    this.stop();
    this.stream = stream;
    this.video.srcObject = stream;
    stream.getVideoTracks()[0]?.addEventListener('ended', () => this.onEnded?.());
    await this.video.play();
  }

  async startFile(file) {
    this.stop();
    this.url = URL.createObjectURL(file);
    this.video.src = this.url;
    this.video.loop = true;
    await this.video.play();
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.pause();
    this.video.srcObject = null;
    this.video.removeAttribute('src');
    this.video.load();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
  }
}
