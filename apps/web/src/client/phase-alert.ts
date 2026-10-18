import type { InPhase } from "../domain/phase-change.ts";
import { loadAlertSettings, type Volume } from "./alert-settings.ts";
import { phaseChangeMessageOf } from "./timer-text.ts";

/**
 * フェーズの切り替わりを音とブラウザ通知で知らせる（docs/PRODUCT.md「タイマー」）。Web Push は使わない。
 * 音を鳴らすか・音量・通知を出すかは、知らせるたびに知らせ方の設定（`alert-settings.ts`）を読んで決める。
 *
 * ブラウザは人の操作なしに音を鳴らすことと通知の許可を求めることを許さないので、
 * `prepare` を開始ボタンなどの操作の中で呼ぶ。
 */
export type PhaseAlert = Readonly<{
  /** 音を鳴らせるようにし、通知を出す設定でまだ聞いていなければ通知の許可を求める。人の操作の中で呼ぶ */
  prepare: () => void;
  /** 音を鳴らせるようにする。ページを開き直したあと、最初に画面に触れたときに呼ぶ */
  unlockSound: () => void;
  /** 設定画面で音量を確かめるために鳴らす。人の操作の中で呼ぶ */
  preview: (volume: Volume) => void;
  alert: (to: InPhase) => void;
  /** 今の音の状態。まだ画面に触れておらず音を鳴らせなければ `Locked`（知らせた記録に残す、alert-log.ts） */
  soundState: () => AudioContextState | "Locked";
}>;

/** ブラウザ通知の許可の状態。通知のないブラウザでは `unsupported` */
export type NotificationPermissionState = NotificationPermission | "unsupported";

/** フェーズごとの音の高さ（Hz）の並び。どのフェーズに移ったかを音だけでも聞き分けられるようにする */
const CHIMES: Readonly<Record<InPhase["kind"], ReadonlyArray<number>>> = {
  /** 上がる2音: 集中を始める */
  Focus: [784, 1175],
  /** 高い1音を2回: 書く時間 */
  Journal: [1047, 1047],
  /** 下がる3音: 休む */
  Break: [1175, 880, 659],
};

/**
 * 1音を作る倍音（基音に対する周波数の比と大きさ）。純音（sine 1つ）はノートパソコンのスピーカーでは
 * 小さく聞こえて気づきにくいので、鐘のように倍音を重ねて耳につく音にする
 */
const PARTIALS = [
  { ratio: 1, level: 1 },
  { ratio: 2, level: 0.5 },
  { ratio: 3, level: 0.3 },
  { ratio: 4.2, level: 0.15 },
] as const;

/** 音を鳴らし始めてから次の音までの秒数。前の音の余韻に重ねる */
const NOTE_SPACING_SECONDS = 0.22;
/** 1音が鳴り始めてから消えるまでの秒数 */
const DECAY_SECONDS = 1.1;
/** 画面から離れていても気づけるよう、同じ並びを繰り返す回数と、その間の秒数 */
const REPEATS = 2;
const REPEAT_GAP_SECONDS = 0.5;

/**
 * 音量ごとに、コンプレッサーの後でかける大きさ。コンプレッサーが山を抑えるので、大でも波形の山は
 * 1（音割れする手前）に届かない。小は以前の音（sine 1つ・0.3）と同じくらいの山にしてある
 */
const VOLUME_GAIN: Readonly<Record<Volume, number>> = { Low: 0.5, Medium: 1, High: 1.5 };

/** 1音を鳴らす。倍音ごとに Oscillator を作り、立ち上がりを短く・余韻を長くする */
const scheduleNote = (
  audio: BaseAudioContext,
  output: AudioNode,
  frequency: number,
  startsAt: number,
) => {
  for (const { ratio, level } of PARTIALS) {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency * ratio;
    // 立ち上がりをつけて、ぷつっという音を出さない。高い倍音ほど早く消えると鐘らしく聞こえる
    const endsAt = startsAt + DECAY_SECONDS / ratio ** 0.5;
    gain.gain.setValueAtTime(0.0001, startsAt);
    gain.gain.exponentialRampToValueAtTime(level, startsAt + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, endsAt);
    oscillator.connect(gain).connect(output);
    oscillator.start(startsAt);
    oscillator.stop(endsAt);
  }
};

/**
 * 音源のファイルは持たず、Web Audio で音を合成して鳴らす（ライセンスと配信の大きさを気にしなくてよい）。
 * 重ねた音をコンプレッサーで揃えてから音量をかけ、大きくしても音割れさせない
 */
const playChime = (audio: AudioContext, frequencies: ReadonlyArray<number>, volume: Volume) => {
  const compressor = audio.createDynamicsCompressor();
  compressor.threshold.value = -24;
  compressor.knee.value = 12;
  compressor.ratio.value = 8;
  compressor.attack.value = 0.002;
  compressor.release.value = 0.25;
  const master = audio.createGain();
  master.gain.value = VOLUME_GAIN[volume];
  compressor.connect(master).connect(audio.destination);

  const patternSeconds = (frequencies.length - 1) * NOTE_SPACING_SECONDS + REPEAT_GAP_SECONDS;
  for (let repeat = 0; repeat < REPEATS; repeat++) {
    frequencies.forEach((frequency, i) => {
      const startsAt = audio.currentTime + repeat * patternSeconds + i * NOTE_SPACING_SECONDS;
      scheduleNote(audio, compressor, frequency, startsAt);
    });
  }
};

const canNotify = () => typeof Notification !== "undefined";

export const notificationPermission = (): NotificationPermissionState =>
  canNotify() ? Notification.permission : "unsupported";

/** 通知の許可を求める。人の操作の中で呼ぶ。もう答えてあれば聞き直さない（ブラウザが聞き直させない） */
export const requestNotificationPermission = async (): Promise<NotificationPermissionState> => {
  if (!canNotify()) {
    return "unsupported";
  }
  return Notification.permission === "default"
    ? Notification.requestPermission()
    : Notification.permission;
};

const showNotification = (to: InPhase) => {
  if (notificationPermission() !== "granted") {
    return;
  }
  const { title, body } = phaseChangeMessageOf(to);
  try {
    // 同じ tag の通知は置き換わるので、切り替わりの通知が溜まらない
    new Notification(title, { body, tag: "nanaichi-phase-change" });
  } catch {
    // Android の Chrome などは Service Worker なしの通知を例外にする。音では知らせられるので続ける
  }
};

export const createPhaseAlert = (): PhaseAlert => {
  let audio: AudioContext | undefined;

  const unlockSound = (): AudioContext => {
    audio ??= new AudioContext();
    if (audio.state === "suspended") {
      void audio.resume();
    }
    return audio;
  };

  return {
    prepare: () => {
      unlockSound();
      if (loadAlertSettings().notification) {
        void requestNotificationPermission();
      }
    },
    unlockSound: () => {
      unlockSound();
    },
    preview: (volume) => {
      playChime(unlockSound(), CHIMES.Focus, volume);
    },
    alert: (to) => {
      const { sound, volume, notification } = loadAlertSettings();
      if (sound && audio !== undefined) {
        playChime(audio, CHIMES[to.kind], volume);
      }
      if (notification) {
        showNotification(to);
      }
    },
    soundState: () => audio?.state ?? "Locked",
  };
};
