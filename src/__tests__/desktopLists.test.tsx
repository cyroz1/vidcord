// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import AudioTrackPicker from "../components/AudioTrackPicker";
import EncodersDialog from "../components/EncodersDialog";
import type { AudioTrack } from "../ipc";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(tight = false) {
  container = document.createElement("div");
  container.className = "app";
  if (tight) container.setAttribute("data-compact-tight", "");
  document.body.appendChild(container);
  root = createRoot(container);
  return root;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

it("pages audio tracks while preserving selections on other pages", async () => {
  const tracks: AudioTrack[] = Array.from({ length: 5 }, (_, index) => ({
    index,
    name: `Track ${index + 1}`,
    codec: "aac",
    bitrate_kbps: 128,
    duration: 1,
    size_bytes: 1000,
    channels: 2,
  }));
  function Picker() {
    const [selected, setSelected] = useState<number[] | null>([]);
    return (
      <AudioTrackPicker
        tracks={tracks}
        selection={selected}
        removeAudio={false}
        audioNormalize={false}
        onChange={setSelected}
        onRemoveAudioChange={vi.fn()}
        onAudioNormalizeChange={vi.fn()}
      />
    );
  }
  await act(async () => mount().render(<Picker />));
  await act(async () =>
    container?.querySelector<HTMLButtonElement>(".audio-settings-btn")?.click()
  );
  await act(async () =>
    container?.querySelector<HTMLInputElement>(".audio-track-option input")?.click()
  );
  await act(async () =>
    [...(container?.querySelectorAll<HTMLButtonElement>(".pagination button") ?? [])][1]?.click()
  );
  expect(container?.querySelector(".audio-track-list")?.textContent).toContain("Track 4");
  await act(async () =>
    container?.querySelector<HTMLInputElement>(".audio-track-option input")?.click()
  );
  await act(async () => container?.querySelector<HTMLButtonElement>(".pagination button")?.click());
  expect(container?.querySelector<HTMLInputElement>(".audio-track-option input")?.checked).toBe(
    true
  );
  expect(container?.querySelector(".audio-track-popup-footer")?.textContent).toContain(
    "2 selected"
  );
});

it("shows the complete encoder list across pages", async () => {
  const lines = Array.from({ length: 23 }, (_, index) => `encoder-${index + 1}`).join("\n");
  await act(async () => mount().render(<EncodersDialog text={lines} onClose={vi.fn()} />));
  const text = () => container?.querySelector("pre")?.textContent ?? "";
  expect(text()).toContain("encoder-1\n");
  expect(text()).not.toContain("encoder-11");
  await act(async () =>
    [...(container?.querySelectorAll<HTMLButtonElement>(".pagination button") ?? [])][1]?.click()
  );
  expect(text()).toContain("encoder-11");
  await act(async () =>
    [...(container?.querySelectorAll<HTMLButtonElement>(".pagination button") ?? [])][1]?.click()
  );
  expect(text()).toContain("encoder-23");
  expect(
    container?.querySelector<HTMLButtonElement>(".pagination button:last-child")?.disabled
  ).toBe(true);
});

it("uses shorter pages for audio tracks and encoders on a very short display", async () => {
  const tracks: AudioTrack[] = Array.from({ length: 3 }, (_, index) => ({
    index,
    name: `Track ${index + 1}`,
    codec: "aac",
    bitrate_kbps: 128,
    duration: 1,
    size_bytes: 1000,
    channels: 2,
  }));
  const lines = Array.from({ length: 12 }, (_, index) => `encoder-${index + 1}`).join("\n");
  await act(async () =>
    mount(true).render(
      <>
        <AudioTrackPicker
          tracks={tracks}
          selection={[]}
          removeAudio={false}
          audioNormalize={false}
          onChange={vi.fn()}
          onRemoveAudioChange={vi.fn()}
          onAudioNormalizeChange={vi.fn()}
        />
        <EncodersDialog text={lines} onClose={vi.fn()} />
      </>
    )
  );
  await act(async () =>
    container?.querySelector<HTMLButtonElement>(".audio-settings-btn")?.click()
  );
  expect(container?.querySelectorAll(".audio-track-option")).toHaveLength(1);
  expect(container?.querySelector(".encoders-dialog pre")?.textContent).toContain("encoder-6");
  expect(container?.querySelector(".encoders-dialog pre")?.textContent).not.toContain("encoder-7");
  await act(async () => {
    container?.removeAttribute("data-compact-tight");
    await Promise.resolve();
  });
  expect(container?.querySelectorAll(".audio-track-option")).toHaveLength(3);
  expect(container?.querySelector(".encoders-dialog pre")?.textContent).toContain("encoder-10");
});
