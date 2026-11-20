"use client";

import { useRouter } from "@/shared/router/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Bookmark,
  Download,
  Loader2,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";

import Tooltip from "@/shared/ui/Tooltip";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  FeaturePage,
  PageHeader,
  pageActionClass,
} from "@/components/layout/FeaturePage";
import { PageBarSlot } from "@/components/layout/PageChrome";
import {
  InstanceCrumb,
  type CrumbItem,
} from "@/components/layout/LocationCrumbs";
import "@/components/notebook/favorites.css";
import NotebookRecordRow from "@/components/notebook/NotebookRecordRow";
import PickerShell from "@/components/common/PickerShell";
import { FolderGlyph } from "@/components/reading/library/FolderGlyph";
import {
  FavoriteKindIcon,
  favoriteLabel,
} from "@/components/notebook/favorite-kinds";
import { favoriteKind } from "@/lib/favorite-content";
import { RecordTime } from "@/components/sidebar/RecordList";
import { useNotebookLibrary } from "@/components/notebook/useNotebookLibrary";
import { notify } from "@/lib/notifications";
import {
  exportNotebookMarkdown,
  getNotebook,
  listNotebooks,
  locateFavoriteRecord,
  type NotebookRecordItem,
  type NotebookSummary,
} from "@/lib/notebook-api";
import { notebookRoute } from "@/lib/resource-routes";

// Indigo first: it is what every notebook was created with before colours
// could be picked. The rest follow the folder palette in globals.css.
const SWATCHES = [
  "#6366F1",
  "#4F86F7",
  "#1FB5A8",
  "#43B05C",
  "#EAA221",
  "#F07B3F",
  "#E8577A",
  "#8E6CF0",
  "#6B7A90",
];
const DEFAULT_COLOR = SWATCHES[0];

interface NotebookConsoleProps {
  /** Notebook to open on arrival from `/notebooks/<id>`; none is the list. */
  initialNotebookId?: string | null;
  initialRecordId?: string | null;
  /** Arrive with the new-notebook form open (`/notebooks?create=1`). */
  startCreating?: boolean;
}

/**
 * Favorites, as every feature reads: `/notebooks` lists the notebooks, and
 * `/notebooks/<id>` is one of them — Favorites / its name in the page bar,
 * where the name switches to the others. Notebooks are created and edited
 * from the list; the open one can be edited, exported or deleted from its
 * own header.
 */
export default function NotebookConsole({
  initialNotebookId,
  initialRecordId = null,
  startCreating = false,
}: NotebookConsoleProps) {
  
  const router = useRouter();
  const library = useNotebookLibrary(initialNotebookId);
  const [banner, setBanner] = useState<string | null>(null);
  const fail = useCallback(
    (err: unknown) =>
      setBanner(err instanceof Error ? err.message : String(err)),
    [],
  );

  if (library.loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--muted-foreground)]" />
      </div>
    );
  }

  const bannerNode = banner ? (
    <div
      role="alert"
      className="mb-4 flex items-center gap-2 rounded-lg bg-[var(--destructive)]/10 px-3 py-2 text-[12px] text-[var(--destructive)]"
    >
      <AlertTriangle size={13} />
      <span className="flex-1">{banner}</span>
      <button
        type="button"
        onClick={() => setBanner(null)}
        aria-label={"Dismiss"}
      >
        <X size={13} />
      </button>
    </div>
  ) : null;

  if (library.error) {
    return (
      <FeaturePage>
        <ConsoleNotice
          tone="error"
          title={"Could not load your favorites collections"}
          detail={library.error}
          action={
            <button
              type="button"
              onClick={() => void library.reload()}
              className="rounded-lg bg-[var(--primary)] px-3.5 py-1.5 text-[12px] font-medium text-[var(--primary-foreground)]"
            >
              {"Retry"}
            </button>
          }
        />
      </FeaturePage>
    );
  }

  if (!initialNotebookId) {
    return (
      <NotebookList
        library={library}
        startCreating={startCreating}
        banner={bannerNode}
        onError={fail}
        onOpen={(id) => router.push(notebookRoute(id))}
      />
    );
  }
  return (
    <NotebookDetail
      library={library}
      notebookId={initialNotebookId}
      initialRecordId={initialRecordId}
      banner={bannerNode}
      onError={fail}
    />
  );
}

type Library = ReturnType<typeof useNotebookLibrary>;

// ── The list ───────────────────────────────────────────────────────────

/** A peek inside each collection: its newest items and what kinds it holds.
 *  Collections are few and small, so one detail read each is cheap; a failed
 *  read just leaves that card without its peek. */
function useCollectionPeeks(notebooks: NotebookSummary[]) {
  const [peeks, setPeeks] = useState<Record<string, NotebookRecordItem[]>>({});
  const signature = notebooks
    .map(
      (notebook) =>
        `${notebook.id}:${notebook.record_count ?? 0}:${notebook.updated_at ?? 0}`,
    )
    .join("|");
  useEffect(() => {
    let cancelled = false;
    const readable = notebooks.filter(
      (notebook) => !notebook.unreadable && (notebook.record_count ?? 0) > 0,
    );
    void Promise.all(
      readable.map((notebook) =>
        getNotebook(notebook.id)
          .then((detail) => [notebook.id, detail.records] as const)
          .catch(() => [notebook.id, [] as NotebookRecordItem[]] as const),
      ),
    ).then((rows) => {
      if (!cancelled) setPeeks(Object.fromEntries(rows));
    });
    return () => {
      cancelled = true;
    };
    // Re-read when a collection's contents change, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  return peeks;
}

function NotebookList({
  library,
  startCreating,
  banner,
  onError,
  onOpen,
}: {
  library: Library;
  startCreating: boolean;
  banner: React.ReactNode;
  onError: (err: unknown) => void;
  onOpen: (id: string) => void;
}) {
  
  const router = useRouter();
  const { notebooks } = library;
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(startCreating);
  const [editingId, setEditingId] = useState<string | null>(null);
  const peeks = useCollectionPeeks(notebooks);
  const editing = notebooks.find((notebook) => notebook.id === editingId);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const sorted = [...notebooks].sort(
      (a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0),
    );
    if (!needle) return sorted;
    return sorted.filter((notebook) =>
      [
        notebook.name,
        notebook.description ?? "",
        ...(peeks[notebook.id] ?? []).map((record) => record.title),
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [notebooks, peeks, query]);
  const total = notebooks.reduce(
    (sum, notebook) => sum + (notebook.record_count ?? 0),
    0,
  );

  return (
    <FeaturePage>
      <PageHeader
        title={"Favorites"}
        icon={Bookmark}
        action={
          <button
            type="button"
            onClick={() => setCreating(true)}
            aria-expanded={creating}
            className={pageActionClass("primary")}
          >
            <Plus size={14} strokeWidth={2} />
            {"New collection"}
          </button>
        }
      />
      {banner}
      {notebooks.length > 0 && (
        <div className="dt-fav-home-toolbar">
          <label className="dt-fav-home-search">
            <Search size={14} strokeWidth={1.7} aria-hidden />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={"Search favorites…"}
              aria-label={"Filter favorites collections"}
            />
          </label>
          <span className="dt-fav-home-count">
            {`${notebooks.length} folders · ${total} items`}
          </span>
        </div>
      )}
      <nav aria-label={"Favorites"}>
        <ul className="dt-fav-grid">
          {visible.map((notebook) => (
            <CollectionCard
              key={notebook.id}
              notebook={notebook}
              records={peeks[notebook.id]}
              onOpen={() => onOpen(notebook.id)}
              onEdit={() => setEditingId(notebook.id)}
            />
          ))}
          {!query && notebooks.length > 0 && (
            <li>
              <button
                type="button"
                className="dt-fav-card is-new"
                onClick={() => setCreating(true)}
              >
                <Plus size={18} strokeWidth={1.7} />
                {"New collection"}
              </button>
            </li>
          )}
        </ul>
        {!visible.length && (
          <div data-test="notebooks-empty" className="dt-fav-home-empty">
            {notebooks.length ? (
              <p>{"No favorites collections match your filter."}</p>
            ) : (
              <>
                <FolderGlyph tone="var(--folder-default)" files={0} size={64} />
                <p className="dt-fav-home-empty-title">
                  {"No favorites collections yet."}
                </p>
                <p>
                  {"Save a conversation, a research report or a question from anywhere in DeepTutor, and file it in a folder here."}
                </p>
                <button
                  type="button"
                  className={pageActionClass("primary")}
                  onClick={() => setCreating(true)}
                >
                  <Plus size={14} strokeWidth={2} />
                  {"New collection"}
                </button>
              </>
            )}
          </div>
        )}
      </nav>
      {creating && (
        <NotebookMetaDialog
          label={"New collection"}
          submitLabel={"Create"}
          onCancel={() => setCreating(false)}
          onSubmit={async ({ name, description, color }) => {
            try {
              const createdId = await library.create(name, description, color);
              setCreating(false);
              if (createdId) router.push(notebookRoute(createdId));
            } catch (err) {
              onError(err);
            }
          }}
        />
      )}
      {editing && (
        <NotebookMetaDialog
          label={"Edit collection"}
          submitLabel={"Save"}
          initial={editing}
          onCancel={() => setEditingId(null)}
          onSubmit={async (changes) => {
            try {
              await library.rename(editing.id, changes);
              setEditingId(null);
            } catch (err) {
              onError(err);
            }
          }}
        />
      )}
    </FeaturePage>
  );
}

/** A collection as a folder of files: what is inside, newest first. */
function CollectionCard({
  notebook,
  records,
  onOpen,
  onEdit,
}: {
  notebook: NotebookSummary;
  records?: NotebookRecordItem[];
  onOpen: () => void;
  onEdit: () => void;
}) {
  
  const count = notebook.record_count ?? records?.length ?? 0;
  const newest = [...(records ?? [])]
    .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
    .slice(0, 3);
  const tone = notebook.color || DEFAULT_COLOR;
  return (
    <li className="group/nb relative">
      <button type="button" onClick={onOpen} className="dt-fav-card">
        <span className="dt-fav-card-head">
          <FolderGlyph tone={tone} files={count} size={40} />
          <span className="min-w-0 flex-1">
            <span className="dt-fav-card-title">{notebook.name}</span>
            <span className="dt-fav-card-sub">
              {notebook.unreadable ? (
                <span className="inline-flex items-center gap-1 text-[var(--destructive)]">
                  <AlertTriangle size={12} />
                  {"Unreadable"}
                </span>
              ) : (
                (count === 1 ? `${count} item` : `${count} items`)
              )}
              {notebook.updated_at ? (
                <>
                  {" · "}
                  <RecordTime seconds={notebook.updated_at} />
                </>
              ) : null}
            </span>
          </span>
        </span>
        {notebook.description && (
          <span className="dt-fav-card-desc">{notebook.description}</span>
        )}
        {newest.length ? (
          <span className="dt-fav-card-files">
            {newest.map((record) => (
              <span key={record.id} className="dt-fav-card-file">
                <FavoriteKindIcon
                  kind={favoriteKind(record.type, record.metadata)}
                  size={12}
                />
                <span className="truncate">
                  {record.title || "Favorite content"}
                </span>
              </span>
            ))}
            {count > newest.length && (
              <span className="dt-fav-card-more">
                {`+${count - newest.length} more`}
              </span>
            )}
          </span>
        ) : (
          <span className="dt-fav-card-files is-empty">
            {count ? "" : "Empty folder"}
          </span>
        )}
      </button>
      <Tooltip label={"Edit collection"} side="bottom">
        <button
          type="button"
          aria-label={"Edit collection"}
          onClick={onEdit}
          className="dt-fav-card-edit"
        >
          <Pencil size={13} />
        </button>
      </Tooltip>
    </li>
  );
}

// ── One notebook ───────────────────────────────────────────────────────

function NotebookDetail({
  library,
  notebookId,
  initialRecordId,
  banner,
  onError,
}: {
  library: Library;
  notebookId: string;
  initialRecordId: string | null;
  banner: React.ReactNode;
  onError: (err: unknown) => void;
}) {
  
  const router = useRouter();
  const { notebooks, selected, selectedId } = library;
  const [recordQuery, setRecordQuery] = useState("");
  const [recordKind, setRecordKind] = useState("");
  const [recordError, setRecordError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const recordRef = useRef<HTMLDivElement>(null);
  const handledRecordRouteRef = useRef<string | null>(null);
  const expandedRecordId = initialRecordId;
  const summary = notebooks.find((notebook) => notebook.id === notebookId);
  const name = selected?.name ?? summary?.name ?? "";
  const color = selected?.color ?? summary?.color ?? DEFAULT_COLOR;

  // Resolve moved favorites only after the requested collection has loaded.
  // Never silently open an unrelated record when a saved source is gone.
  useEffect(() => {
    let cancelled = false;
    setRecordError(null);
    if (!initialRecordId) {
      handledRecordRouteRef.current = null;
      return;
    }
    if (
      library.loading ||
      library.detailLoading ||
      selectedId !== notebookId
    )
      return;
    if (
      selected?.id === notebookId &&
      selected.records.some((record) => record.id === initialRecordId)
    ) {
      const route = notebookRoute(notebookId, initialRecordId);
      // Locate incoming source links once. In-place toggles mark their route
      // as handled so neither opening nor refreshing a record moves the page.
      if (handledRecordRouteRef.current !== route && recordRef.current) {
        handledRecordRouteRef.current = route;
        recordRef.current.scrollIntoView({ block: "start" });
      }
      return;
    }
    if (selected && selected.id !== notebookId) return;
    if (!selected && !library.detailError) return;
    void locateFavoriteRecord(initialRecordId, notebookId)
      .then((collectionId) => {
        if (cancelled) return;
        if (collectionId && collectionId !== notebookId) {
          router.replace(notebookRoute(collectionId, initialRecordId));
        } else {
          setRecordError("This favorite is no longer available.");
        }
      })
      .catch(() => {
        if (!cancelled)
          setRecordError(
            "Could not locate this favorite. Try reopening the source link.",
          );
      });
    return () => {
      cancelled = true;
    };
  }, [initialRecordId, notebookId, library.loading, library.detailLoading, library.detailError, selected, selectedId, router]);

  const kinds = useMemo(
    () => [
      ...new Set(
        (selected?.records ?? []).map((record) =>
          favoriteKind(record.type, record.metadata),
        ),
      ),
    ],
    [selected],
  );
  const visibleRecords = useMemo(() => {
    const records = selected?.records ?? [];
    const needle = recordQuery.trim().toLowerCase();
    if (!needle && !recordKind) return records;
    return records.filter(
      (record) =>
        record.id === initialRecordId ||
        ((!recordKind ||
          favoriteKind(record.type, record.metadata) === recordKind) &&
          `${record.title} ${record.summary ?? ""} ${record.output ?? ""}`
            .toLowerCase()
            .includes(needle)),
    );
  }, [selected, recordQuery, recordKind, initialRecordId]);

  const loadNotebooks = useCallback(
    async (): Promise<CrumbItem[]> =>
      (await listNotebooks()).map((notebook) => ({
        id: notebook.id,
        label: notebook.name,
        href: notebookRoute(notebook.id),
        color: notebook.color || DEFAULT_COLOR,
        detail: String(notebook.record_count ?? 0),
      })),
    [],
  );

  const handleDelete = useCallback(async () => {
    setDeleting(true);
    try {
      await library.remove(notebookId);
      router.replace(notebookRoute());
      notify(`Deleted "${name}"`, { tone: "success" });
      setConfirmingDelete(false);
    } catch (err) {
      onError(err);
    } finally {
      setDeleting(false);
    }
  }, [library, name, notebookId, onError, router]);

  const handleExport = useCallback(async () => {
    try {
      const markdown = await exportNotebookMarkdown(notebookId);
      const blob = new Blob([markdown], {
        type: "text/markdown;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${name || notebookId}.md`;
      anchor.click();
      URL.revokeObjectURL(url);
      notify("Favorites exported", { tone: "success" });
    } catch (err) {
      onError(err);
    }
  }, [name, notebookId, onError]);

  const openSession = useCallback(
    (sessionId: string) =>
      router.push(`/chat/${encodeURIComponent(sessionId)}`),
    [router],
  );

  const missing = !selected && !library.detailLoading;
  return (
    <FeaturePage>
      <PageBarSlot name="instance">
        <InstanceCrumb
          label={name || "Favorites"}
          color={color}
          menuLabel={"Favorites"}
          currentId={notebookId}
          load={loadNotebooks}
          create={{ label: "New collection", href: "/notebooks?create=1" }}
          all={{ label: "All notebooks", href: notebookRoute() }}
          onRename={selected ? () => setEditing(true) : undefined}
        />
      </PageBarSlot>
      {banner}
      {recordError && (
        <p
          role="alert"
          className="mb-4 rounded-lg bg-[var(--muted)] px-3 py-2.5 text-[13px]"
        >
          {recordError}
        </p>
      )}
      {missing ? (
        <ConsoleNotice
          tone="empty"
          title={"This collection could not be opened"}
          detail={library.detailError ?? "It may have been deleted."}
        />
      ) : (
        <>
          <PageHeader
            title={
              <span className="inline-flex min-w-0 items-center gap-3">
                <FolderGlyph
                  tone={color}
                  files={selected?.records.length ?? 0}
                  size={34}
                />
                <span className="min-w-0 truncate">{name}</span>
              </span>
            }
            description={selected?.description || undefined}
            meta={
              <span className="text-[12.5px] tabular-nums text-[var(--muted-foreground)]">
                {(selected?.records.length ?? 0) === 1
                  ? `${selected?.records.length ?? 0} item`
                  : `${selected?.records.length ?? 0} items`}
              </span>
            }
            action={
              <div className="flex items-center gap-0.5">
                <HeaderAction
                  label={"Edit collection"}
                  icon={Pencil}
                  onClick={() => setEditing(true)}
                />
                <HeaderAction
                  label={"Export as Markdown"}
                  icon={Download}
                  onClick={() => void handleExport()}
                />
                <HeaderAction
                  label={"Delete collection"}
                  icon={Trash2}
                  tone="danger"
                  onClick={() => setConfirmingDelete(true)}
                />
              </div>
            }
          />
          {editing && selected && (
            <NotebookMetaDialog
              label={"Edit collection"}
              submitLabel={"Save"}
              initial={selected}
              onCancel={() => setEditing(false)}
              onSubmit={async (changes) => {
                try {
                  await library.rename(notebookId, changes);
                  setEditing(false);
                } catch (err) {
                  onError(err);
                }
              }}
            />
          )}

          {(selected?.records.length ?? 0) > 0 && (
            <div className="dt-fav-home-toolbar">
              <label className="dt-fav-home-search">
                <Search size={14} strokeWidth={1.7} aria-hidden />
                <input
                  value={recordQuery}
                  onChange={(event) => setRecordQuery(event.target.value)}
                  placeholder={"Search records in this collection"}
                  aria-label={"Search records in this collection"}
                />
              </label>
              {kinds.length > 1 && (
                <div
                  className="dt-fav-chips"
                  role="group"
                  aria-label={"Type"}
                >
                  <button
                    type="button"
                    aria-pressed={!recordKind}
                    onClick={() => setRecordKind("")}
                  >
                    {"All"}
                  </button>
                  {kinds.map((value) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={recordKind === value}
                      onClick={() =>
                        setRecordKind(recordKind === value ? "" : value)
                      }
                    >
                      {(favoriteLabel(value))}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {library.detailLoading ? (
            <div className="flex justify-center py-16">
              <Loader2 className="h-5 w-5 animate-spin text-[var(--muted-foreground)]" />
            </div>
          ) : visibleRecords.length ? (
            <div className="dt-fav-record-list">
              {visibleRecords.map((record) => (
                <div
                  key={record.id}
                  ref={record.id === initialRecordId ? recordRef : undefined}
                  className="scroll-mt-3"
                >
                  <NotebookRecordRow
                    record={record}
                    notebooks={notebooks}
                    currentNotebookId={notebookId}
                    expanded={expandedRecordId === record.id}
                    onToggle={() => {
                      const route = notebookRoute(
                        notebookId,
                        expandedRecordId === record.id ? null : record.id,
                      );
                      handledRecordRouteRef.current = route;
                      router.replace(route, { scroll: false });
                    }}
                    onEdit={library.editRecord}
                    onDelete={library.removeRecord}
                    onRelocate={library.relocateRecord}
                    onOpenSession={openSession}
                  />
                </div>
              ))}
            </div>
          ) : (
            <ConsoleNotice
              tone="empty"
              title={
                recordQuery || recordKind
                  ? "No records match your search"
                  : "This collection is empty"
              }
              detail={
                recordQuery || recordKind
                  ? "Try a different word."
                  : "Save a conversation, a research result, or a reading excerpt here."
              }
            />
          )}
        </>
      )}

      <ConfirmDialog
        open={confirmingDelete && Boolean(selected)}
        title={"Delete this collection?"}
        confirmLabel={"Delete"}
        tone="danger"
        busy={deleting}
        onConfirm={() => void handleDelete()}
        onCancel={() => setConfirmingDelete(false)}
      >
        <p className="text-[13px] leading-relaxed text-[var(--muted-foreground)]">
          {(selected?.record_count ?? 0) > 0
            ? `"${name}" and its ${selected?.record_count ?? 0} records will be deleted. This cannot be undone.`
            : `"${name}" will be deleted.`}
        </p>
      </ConfirmDialog>
    </FeaturePage>
  );
}

// ── Pieces ─────────────────────────────────────────────────────────────

/** Create or edit a notebook: name, description and folder colour, with the
 *  folder drawn as it will appear on the list. */
function NotebookMetaDialog({
  label,
  submitLabel,
  initial,
  onCancel,
  onSubmit,
}: {
  label: string;
  submitLabel: string;
  initial?: NotebookSummary;
  onCancel: () => void;
  onSubmit: (changes: {
    name: string;
    description: string;
    color: string;
  }) => void | Promise<void>;
}) {
  
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [color, setColor] = useState(initial?.color ?? DEFAULT_COLOR);
  const [busy, setBusy] = useState(false);
  const swatches = SWATCHES.includes(color) ? SWATCHES : [color, ...SWATCHES];
  return (
    <PickerShell open onClose={onCancel} ariaLabel={label}>
      <form
        aria-label={label}
        className="dt-fav-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim() || busy) return;
          setBusy(true);
          void Promise.resolve(
            onSubmit({
              name: name.trim(),
              description: description.trim(),
              color,
            }),
          ).finally(() => setBusy(false));
        }}
      >
        <div className="dt-fav-dialog-preview">
          <FolderGlyph
            tone={color}
            files={initial?.record_count ?? 0}
            size={72}
          />
        </div>
        <h2 className="dt-fav-dialog-title">{label}</h2>
        <label className="dt-fav-field">
          <span>{"Collection name"}</span>
          <input
            autoFocus
            aria-label={"Collection name"}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={"e.g. Thermodynamics, Exam review"}
          />
        </label>
        <label className="dt-fav-field">
          <span>{"Description (optional)"}</span>
          <input
            aria-label={"Description (optional)"}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={"What goes in this folder"}
          />
        </label>
        <div className="dt-fav-field">
          <span>{"Colour"}</span>
          <div
            className="dt-fav-swatches"
            role="radiogroup"
            aria-label={"Colour"}
          >
            {swatches.map((swatch) => (
              <button
                key={swatch}
                type="button"
                role="radio"
                aria-label={swatch}
                aria-checked={color === swatch}
                onClick={() => setColor(swatch)}
                style={{ background: swatch }}
              />
            ))}
          </div>
        </div>
        <div className="dt-fav-dialog-actions">
          <button type="button" className="dt-fav-button" onClick={onCancel}>
            {"Cancel"}
          </button>
          <button
            type="submit"
            className="dt-fav-button is-primary"
            disabled={!name.trim() || busy}
          >
            {submitLabel}
          </button>
        </div>
      </form>
    </PickerShell>
  );
}

function HeaderAction({
  label,
  icon: Icon,
  onClick,
  tone = "default",
}: {
  label: string;
  icon: typeof Pencil;
  onClick: () => void;
  tone?: "default" | "danger";
}) {
  return (
    <Tooltip label={label} side="bottom">
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        className={`inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--muted-foreground)] transition-[background-color,color,transform] duration-150 active:scale-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${
          tone === "danger"
            ? "hover:bg-[var(--destructive)]/10 hover:text-[var(--destructive)]"
            : "hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
        }`}
      >
        <Icon size={15} strokeWidth={1.6} />
      </button>
    </Tooltip>
  );
}

function ConsoleNotice({
  tone,
  title,
  detail,
  action,
}: {
  tone: "empty" | "error";
  title: string;
  detail: string;
  action?: React.ReactNode;
}) {
  const Icon = tone === "error" ? AlertTriangle : Bookmark;
  return (
    <div
      role={tone === "error" ? "alert" : undefined}
      className="flex flex-col items-center justify-center gap-2.5 px-6 py-16 text-center"
    >
      <span
        className={`flex h-9 w-9 items-center justify-center rounded-xl ${
          tone === "error"
            ? "bg-[var(--destructive)]/10 text-[var(--destructive)]"
            : "bg-[var(--muted)] text-[var(--muted-foreground)]"
        }`}
      >
        <Icon size={16} />
      </span>
      <p className="text-[13.5px] font-medium text-[var(--foreground)]">
        {title}
      </p>
      <p className="max-w-sm text-[12.5px] leading-relaxed text-[var(--muted-foreground)]">
        {detail}
      </p>
      {action}
    </div>
  );
}
