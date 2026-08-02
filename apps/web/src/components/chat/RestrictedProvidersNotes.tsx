/**
 * "Not available in this project" notes: enabled provider instances a
 * project's access rules keep out of the composer, each attributed to the
 * rule that hid it. Rendered as the model picker's footer and inside the
 * no-provider-available popover, so a restriction never reads as a provider
 * silently vanishing.
 */
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import type { ProviderInstanceEntry } from "../../providerInstances";

export interface RestrictedProviderNote {
  readonly entry: ProviderInstanceEntry;
  readonly cause: "project-allowlist" | "instance-scope";
}

export function restrictedProviderNoteTitle(note: RestrictedProviderNote): string {
  return note.cause === "instance-scope"
    ? `${note.entry.displayName} is limited to other projects. Change its project scope in Settings → Providers.`
    : `${note.entry.displayName} is not in this project's allowed providers. Change it in the project's settings.`;
}

export function RestrictedProvidersNotes(props: { notes: ReadonlyArray<RestrictedProviderNote> }) {
  return (
    <div>
      <p className="text-[11px] font-medium text-muted-foreground">Not available in this project</p>
      <div className="mt-1 grid gap-1">
        {props.notes.map((note) => (
          <div
            key={note.entry.instanceId}
            className="flex items-center gap-1.5 text-[11px] text-muted-foreground/80"
            title={restrictedProviderNoteTitle(note)}
          >
            <ProviderInstanceIcon
              driverKind={note.entry.driverKind}
              displayName={note.entry.displayName}
              accentColor={note.entry.accentColor}
              className="size-3.5 opacity-60"
              iconClassName="size-3.5"
            />
            <span className="min-w-0 truncate">{note.entry.displayName}</span>
            <span className="ml-auto shrink-0 opacity-70">
              {note.cause === "instance-scope" ? "Provider setting" : "Project setting"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
