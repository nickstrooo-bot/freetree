import { useState } from "react";
import type { BookingBlock } from "@kytelink/schemas";
import { useEditor } from "../../../../lib/editor/editor-context";
import { GripVertical, Plus, CalendarClock } from "lucide-react";
import { SortableList } from "../../../shared/sortable-list";
import { BookingModal } from "../booking-modal";

function bookingKey(block: BookingBlock, index: number): string {
  return `${index}::${block.url}`;
}

export function BookingsTab() {
  const { draft, patchDraft, allows } = useEditor();
  const readOnly = !allows("edit_draft");
  const [modalOpen, setModalOpen] = useState(false);
  const [editIndex, setEditIndex] = useState<number | null>(null);

  const blocks = draft.bookingBlocks ?? [];
  const ids = blocks.map((block, index) => bookingKey(block, index));

  function reorder(nextIds: string[]) {
    const next = nextIds
      .map((id) => blocks[ids.indexOf(id)])
      .filter((block): block is BookingBlock => Boolean(block));
    patchDraft({ bookingBlocks: next });
  }

  function save(block: BookingBlock) {
    if (editIndex !== null) {
      patchDraft({ bookingBlocks: blocks.map((existing, index) => (index === editIndex ? block : existing)) });
    } else {
      patchDraft({ bookingBlocks: [...blocks, block] });
    }
  }

  function remove(index: number) {
    patchDraft({ bookingBlocks: blocks.filter((_, i) => i !== index) });
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
          Add booking button
        </button>
      ) : null}

      {blocks.length === 0 ? (
        <div className="rounded-card border border-cardline bg-card p-8 text-center">
          <p className="text-sm font-medium text-ink">No booking buttons yet</p>
          <p className="mt-1 text-[13px] text-tertiary">
            Link your Calendly, Cal.com, or any scheduling page — visitors get a prominent
            button to book with you.
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
                  <CalendarClock className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-ink">{block.label}</div>
                  <div className="truncate text-xs text-faint">{displayUrl(block.url)}</div>
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

      <BookingModal
        open={modalOpen}
        initial={editIndex !== null ? blocks[editIndex] ?? null : null}
        onClose={() => setModalOpen(false)}
        onSave={save}
        onDelete={editIndex !== null ? () => remove(editIndex) : undefined}
      />
    </div>
  );
}
