import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

const fs = vi.hoisted(() => ({
  fileContent: null as string | null,
  failRead: false,
  failWrite: false,
}));

vi.mock("expo-file-system", () => {
  class Directory {
    constructor(..._args: ReadonlyArray<unknown>) {}
    create(_options?: unknown): void {}
  }
  class File {
    constructor(..._args: ReadonlyArray<unknown>) {}
    get exists(): boolean {
      return fs.fileContent !== null;
    }
    async text(): Promise<string> {
      if (fs.failRead) throw new Error("read failed");
      return fs.fileContent ?? "";
    }
    create(_options?: unknown): void {}
    write(value: string): void {
      if (fs.failWrite) throw new Error("write failed");
      fs.fileContent = value;
    }
  }
  return { Directory, File, Paths: { document: "/documents" } };
});

import { appAtomRegistry } from "./atom-registry";
import {
  ComposerDraftPersistenceError,
  composerDraftsAtom,
  placeContentInEmptyComposerDraft,
} from "./use-composer-drafts";

afterEach(() => {
  appAtomRegistry.set(composerDraftsAtom, {});
});

describe("placeContentInEmptyComposerDraft", () => {
  it("fails closed on hydration failure instead of overwriting persisted drafts", async () => {
    // Disk holds another thread's draft; reading it transiently fails. The
    // placement must refuse — proceeding would treat the unhydrated atom as
    // the full state and overwrite the persisted file with it.
    fs.fileContent = JSON.stringify({
      schemaVersion: 1,
      drafts: { "other-thread": { text: "precious persisted draft", attachments: [] } },
    });
    fs.failRead = true;
    expect(
      await placeContentInEmptyComposerDraft("thread-key", {
        text: "failed message",
        attachments: [],
      }),
    ).toBe("hydration-failed");
    expect(JSON.parse(fs.fileContent).drafts["other-thread"].text).toBe("precious persisted draft");

    // Hydration failure is retryable: once the read succeeds, placement
    // lands WITHOUT losing the previously persisted draft.
    fs.failRead = false;
    expect(
      await placeContentInEmptyComposerDraft("thread-key", {
        text: "failed message",
        attachments: [],
      }),
    ).toBe("placed");
    const persisted = JSON.parse(fs.fileContent!).drafts;
    expect(persisted["other-thread"].text).toBe("precious persisted draft");
    expect(persisted["thread-key"].text).toBe("failed message");
  });

  it("rolls the atom back when the durable write fails", async () => {
    // Hydrated by the previous test's successful load; the atom starts
    // clean. A failed persist must reject AND retract the placed copy so
    // the retained outbox entry stays the only actionable one.
    fs.failWrite = true;
    await expect(
      placeContentInEmptyComposerDraft("thread-key", { text: "failed message", attachments: [] }),
    ).rejects.toBeInstanceOf(ComposerDraftPersistenceError);
    expect(appAtomRegistry.get(composerDraftsAtom)["thread-key"]).toBeUndefined();

    fs.failWrite = false;
    expect(
      await placeContentInEmptyComposerDraft("thread-key", {
        text: "failed message",
        attachments: [],
      }),
    ).toBe("placed");
    expect(appAtomRegistry.get(composerDraftsAtom)["thread-key"]?.text).toBe("failed message");
  });
});
