import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { drawSelection, EditorView, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import type { FileEditFailure } from "../../../shared/ipc-types";
import { describeError } from "../../lib/errors";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { Button } from "../common";
import { ConfirmDialog } from "../common/ConfirmDialog";

type EditFailure = { reason: FileEditFailure; detail?: string };
interface FileDraft {
	initial: string;
	revision: string;
	content: string;
	saving?: boolean;
	failure?: EditFailure;
}

// Window-local drafts survive a file switch, closing the drawer, or opening another panel.
export const useFileDrafts = create<{ drafts: ReadonlyMap<string, FileDraft> }>()(() => ({ drafts: new Map() }));

export function setFileDraft(id: string, draft: FileDraft | null): void {
	useFileDrafts.setState(state => {
		const drafts = new Map(state.drafts);
		if (draft) drafts.set(id, draft);
		else drafts.delete(id);
		return { drafts };
	});
}

const editorTheme = EditorView.theme({
	"&": { height: "100%", color: "var(--omp-text)", backgroundColor: "var(--omp-code-bg)" },
	"&.cm-focused": { outline: "none" },
	".cm-scroller": { fontFamily: "var(--font-mono, monospace)", fontSize: "var(--text-omp-sm)", lineHeight: "1.6" },
	".cm-content": { padding: "8px 0" },
	".cm-line": { padding: "0 10px" },
	".cm-cursor": { borderLeftColor: "var(--omp-accent)" },
	".cm-gutters": {
		backgroundColor: "var(--omp-code-bg)",
		borderRight: "1px solid var(--omp-border-muted)",
		color: "var(--omp-dim)",
	},
	".cm-activeLineGutter": { backgroundColor: "var(--omp-selected-bg)" },
	".cm-selectionBackground": { backgroundColor: "var(--omp-selected-bg) !important" },
});

export function WorkspaceFileEditor({
	draftId,
	path,
	tabId,
	line,
	onReturnToPreview,
}: {
	draftId: string;
	path: string;
	tabId: string | null;
	line: number | null;
	onReturnToPreview: () => void;
}) {
	const t = useT();
	const draft = useFileDrafts(s => s.drafts.get(draftId));
	const host = useRef<HTMLDivElement>(null);
	const [discard, setDiscard] = useState(false);
	const dirty = !!draft && draft.content !== draft.initial;
	const save = async () => {
		const current = useFileDrafts.getState().drafts.get(draftId);
		if (!current || current.saving || current.content === current.initial) return;
		setFileDraft(draftId, { ...current, saving: true, failure: undefined });
		const response = await window.omp.fs
			.saveEdit({ path, tabId: tabId ?? undefined, revision: current.revision, content: current.content })
			.catch((error): { ok: false; reason: "io"; detail: string } => ({
				ok: false,
				reason: "io",
				detail: describeError(error),
			}));
		const latest = useFileDrafts.getState().drafts.get(draftId);
		if (!latest) return;
		if (!response.ok) {
			setFileDraft(draftId, { ...latest, saving: false, failure: response });
			return;
		}
		if (latest.content === response.content) {
			setFileDraft(draftId, null);
			onReturnToPreview();
		} else {
			setFileDraft(draftId, { ...latest, saving: false, initial: response.content, revision: response.revision });
		}
	};
	const discardChanges = () => {
		setFileDraft(draftId, null);
		onReturnToPreview();
	};
	const saveRef = useRef(save);
	saveRef.current = save;
	const editorLabel = t("filesPanel.editorContent");

	// Mount once for a file. Subsequent store updates must not replace the buffer or reset its undo history.
	// biome-ignore lint/correctness/useExhaustiveDependencies: initial caret and document are mount values.
	useEffect(() => {
		const element = host.current;
		const initial = useFileDrafts.getState().drafts.get(draftId);
		if (!element || !initial) return;
		const language = /\.mdx?$/i.test(path) ? [markdown()] : /\.json$/i.test(path) ? [json()] : [];
		const view = new EditorView({
			doc: initial.content,
			extensions: [
				history(),
				drawSelection(),
				lineNumbers(),
				highlightActiveLineGutter(),
				editorTheme,
				...language,
				keymap.of([...defaultKeymap, ...historyKeymap]),
				EditorView.contentAttributes.of({ "aria-label": editorLabel, spellcheck: "false", autocapitalize: "off" }),
				EditorView.updateListener.of(update => {
					const current = useFileDrafts.getState().drafts.get(draftId);
					if (update.docChanged && current)
						setFileDraft(draftId, { ...current, content: update.state.doc.toString() });
				}),
				EditorView.domEventHandlers({
					keydown(event) {
						if (isImeKeyEvent(event) || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s")
							return false;
						event.preventDefault();
						void saveRef.current();
						return true;
					},
				}),
			],
			parent: element,
		});
		if (line && line > 0) {
			const anchor = view.state.doc.line(Math.min(line, view.state.doc.lines)).from;
			view.dispatch({ selection: { anchor }, effects: EditorView.scrollIntoView(anchor, { y: "center" }) });
		}
		view.focus();
		return () => {
			view.destroy();
			const snapshot = useFileDrafts.getState().drafts.get(draftId);
			if (snapshot && !snapshot.saving && snapshot.content === snapshot.initial) setFileDraft(draftId, null);
		};
	}, [draftId]);

	if (!draft) return null;
	return (
		<div className="flex min-h-0 flex-1 flex-col bg-(--omp-code-bg)" data-file-preview="">
			{draft.failure && (
				<p
					className="shrink-0 border-b border-(--omp-border-muted) px-3 py-2 text-omp-sm text-(--omp-error)"
					role="alert"
					title={draft.failure.detail}
				>
					{t(`filesPanel.editError.${draft.failure.reason}`)}
				</p>
			)}
			<div className="min-h-0 flex-1 overflow-hidden" ref={host} />
			<div className="flex shrink-0 items-center justify-end gap-2 border-t border-(--omp-border-muted) px-3 py-1.5">
				{dirty && (
					<span className="min-w-0 flex-1 truncate text-omp-xs text-(--omp-muted)">{t("filesPanel.unsaved")}</span>
				)}
				<Button
					variant="ghost"
					size="sm"
					disabled={draft.saving}
					onClick={() => (dirty ? setDiscard(true) : discardChanges())}
				>
					{t("common.cancel")}
				</Button>
				<Button variant="primary" size="sm" loading={draft.saving} disabled={!dirty} onClick={() => void save()}>
					{t("common.save")}
				</Button>
			</div>
			<ConfirmDialog
				open={discard}
				title={t("filesPanel.discard")}
				message={t("filesPanel.discardHint")}
				confirmLabel={t("filesPanel.discard")}
				onConfirm={discardChanges}
				onCancel={() => setDiscard(false)}
			/>
		</div>
	);
}
