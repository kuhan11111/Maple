// The real voice adapter: joins the channel and plays resources. Hard to unit test (it needs a live
// Discord voice connection), so it is kept thin - all decisions live in player.js.

import { joinVoiceChannel, createAudioPlayer, entersState, VoiceConnectionStatus, AudioPlayerStatus, NoSubscriberBehavior } from '@discordjs/voice';
import { makeResource } from './resource.js';

export async function createVoiceAdapter(channel, { onEnd, onDisconnect }) {
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: true,
  });
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (err) {
    connection.destroy();
    throw new Error('連不上語音頻道(檢查機器人有沒有「連接」和「說話」權限)');
  }
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
  connection.subscribe(player);

  let resource = null;
  player.on(AudioPlayerStatus.Idle, () => {
    if (!resource) return;
    resource = null;
    onEnd();
  });
  player.on('error', (err) => {
    resource = null;
    onEnd(err);
  });
  // Discord moves the bot between channels or drops it: wait briefly for a reconnect, else give up.
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([entersState(connection, VoiceConnectionStatus.Signalling, 5_000), entersState(connection, VoiceConnectionStatus.Connecting, 5_000)]);
    } catch {
      onDisconnect();
    }
  });

  return {
    play(track, volume) {
      resource = makeResource(track, volume);
      player.play(resource);
    },
    stop() {
      resource = null;
      player.stop(true);
    },
    pause: () => player.pause(),
    resume: () => player.unpause(),
    setVolume: (v) => resource?.volume?.setVolume(v),
    destroy() {
      resource = null;
      player.stop(true);
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
    },
  };
}
