import type { InPhase } from "../domain/phase-change.ts";
import { phaseChangeMessageOf } from "./timer-text.ts";

/**
 * フェーズの切り替わりを音とブラウザ通知で知らせる（docs/PRODUCT.md「タイマー」）。Web Push は使わない。
 *
 * ブラウザは人の操作なしに音を鳴らすことと通知の許可を求めることを許さないので、
 * `prepare` を開始ボタンなどの操作の中で呼ぶ。
 */
export type PhaseAlert = Readonly<{
  /** 音を鳴らせるようにし、まだ聞いていなければ通知の許可を求める。人の操作の中で呼ぶ */
  prepare: () => void;
  /** 音を鳴らせるようにする。ページを開き直したあと、最初に画面に触れたときに呼ぶ */
  unlockSound: () => void;
  alert: (to: InPhase) => void;
}>;

/** フェーズごとの音の高さ（Hz）の並び。どのフェーズに移ったかを音だけでも聞き分けられるようにする */
const CHIMES: Readonly<Record<InPhase["kind"], ReadonlyArray<number>>> = {
  /** 上がる2音: 集中を始める */
  Focus: [660, 880],
  /** 高い1音を2回: 書く時間 */
  Journal: [990, 990],
  /** 下がる3音: 休む */
  Break: [880, 660, 520],
};

const TONE_SECONDS = 0.18;
const GAP_SECONDS = 0.07;

/** 音源のファイルは持たず、Web Audio で短い音を合成して鳴らす */
const playChime = (audio: AudioContext, frequencies: ReadonlyArray<number>) => {
  frequencies.forEach((frequency, i) => {
    const startsAt = audio.currentTime + i * (TONE_SECONDS + GAP_SECONDS);
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    // 立ち上がりと減衰をつけて、ぷつっという音を出さない
    gain.gain.setValueAtTime(0.0001, startsAt);
    gain.gain.exponentialRampToValueAtTime(0.3, startsAt + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + TONE_SECONDS);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(startsAt);
    oscillator.stop(startsAt + TONE_SECONDS);
  });
};

const canNotify = () => typeof Notification !== "undefined";

const showNotification = (to: InPhase) => {
  if (!canNotify() || Notification.permission !== "granted") {
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

  const unlockSound = () => {
    audio ??= new AudioContext();
    if (audio.state === "suspended") {
      void audio.resume();
    }
  };

  return {
    prepare: () => {
      unlockSound();
      if (canNotify() && Notification.permission === "default") {
        void Notification.requestPermission();
      }
    },
    unlockSound,
    alert: (to) => {
      if (audio !== undefined) {
        playChime(audio, CHIMES[to.kind]);
      }
      showNotification(to);
    },
  };
};
