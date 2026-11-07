import { useState } from "react";
import type { ScheduledBlock } from "@kytelink/schemas";
import { evaluateScheduledBlock } from "@kytelink/schemas/profile-data";
import { useEditor } from "../../../../lib/editor/editor-context";
import { GripVertical, Plus, Clock } from "lucide-react";
import { SortableList } from "../../../shared/sortable-list";
import { ScheduledBlockModal } from "../scheduled-block-modal";

function scheduledKey(block: ScheduledBlock, index: number): string {
  return `${index}::${block.url}::${block.startsAt}`;
}

function stateLabel(block: ScheduledBlock): { text: string; tone: string } {
  const state = evaluateScheduledBlock(block);
  if (state === "live") return { text: "Live now", tone: "text-success" };
  if (state === "expired") return { text: "Expired", tone: "text-tertiary" };
  return {
    text: `Opens ${new Date(block.startsAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`,
    tone: "text-accent",
  };
}

export function ScheduledTab() {
  const { draft, patchDraft, allows } = useEditor();
  const readOnly = !allows("edit_draft");
  const [modalOpen, setModalOpen] = useState(false);
  const [editIndex, setEditIndex] = useState<number | null>(null);

  const blocks = draft.scheduledBlocks ?? [];
  const ids = blocks.map((block, index) => scheduledKey(block, index));

  function reorder(nextIds: string[]) {
    const next = nextIds
      .map((id) => blocks[ids.indexOf(id)])
      .filter((block): block is ScheduledBlock => Boolean(block));
    patchDraft({ scheduledBlocks: next });
  }

  function save(block: ScheduledBlock) {
    if (editIndex !== null) {
      patchDraft({
        scheduledBlocks: blocks.map((existing, index) => (index === editIndex ? block : existing)),
      });
    } else {
      patchDraft({ scheduledBlocks: [...blocks, block] });
    }
  }

  function remove(index: number) {
    patchDraft({ scheduledBlocks: blocks.filter((_, i) => i !== index) });
  }

  function displayUrl(url: string): string {
    return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  }

  return (
    <div className="flex flex-col gap-3">
      {!readOnly ? (
        <button
          type="button"
          onClick={() => {
            setEditIndex(null);
            setModalOpen(true);
          }}
          className="flex h-[52px] cursor-pointer items-center justify-center gap-2 rounded-card border border-accent-border bg-accent-soft text-sm font-medium text-accent outline-none transition-colors hover:bg-accent-soft/70"
        >
          <Plus className="size-4" />
          Add scheduled block
        </button>
      ) : null}

      {blocks.length === 0 ? (
        <div className="rounded-card border border-cardline bg-card p-8 text-center">
          <p className="text-sm font-medium text-ink">No scheduled blocks yet</p>
          <p className="mt-1 text-[13px] text-tertiary">
            A link that goes live at a time you pick — with a countdown until it
            opens — and disappears when you say so. Drops, launches, limited offers.
          </p>
        </div>
      ) : (
        <SortableList
          ids={ids}
          onReorder={reorder}
          className="flex flex-col gap-3"
          renderItem={(id, handle) => {
            const index = ids.indexOf(id);
            const block = blocks[index];
            if (!block) return null;
            const state = stateLabel(block);
            return (
              <div className="flex items-center gap-3.5 rounded-card border border-cardline bg-card p-4">
                <button
                  {...handle.attributes}
                  {...handle.listeners}
                  disabled={readOnly}
                  className="cursor-grab text-ghost outline-none transition-colors not-disabled:hover:text-tertiary disabled:cursor-not-allowed"
                  aria-label="Drag to reorder"
                >
                  <GripVertical className="size-4" />
                </button>
                <span className="flex size-6 shrink-0 items-center justify-center text-ink">
                  <Clock className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-ink">{block.label}</div>
                  <div className="truncate text-xs text-faint">{displayUrl(block.url)}</div>
                  <div className={`truncate text-xs font-medium ${state.tone}`}>{state.text}</div>
                  {block.description && (
                    <div className="truncate text-xs text-faint">{block.description}</div>
                  )}
                </div>
                {!readOnly ? (
                  <button
                    type="button"
                    onClick={() => {
                      setEditIndex(index);
                      setModalOpen(true);
                    }}
                    className="shrink-0 text-[13px] font-medium text-accent outline-none transition-colors hover:text-accent-hover"
                  >
                    Edit
                  </button>
                ) : null}
              </div>
            );
          }}
        />
      )}

      <ScheduledBlockModal
        open={modalOpen}
        initial={editIndex !== null ? blocks[editIndex] ?? null : null}
        onClose={() => setModalOpen(false)}
        onSave={save}
        onDelete={editIndex !== null ? () => remove(editIndex) : undefined}
      />
    </div>
  );
}
