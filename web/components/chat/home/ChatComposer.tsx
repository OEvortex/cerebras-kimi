"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Paperclip } from "lucide-react";


import { ATTACHMENT_ACCEPT } from "@/lib/doc-attachments";
import { isQuoteAttachment, quoteText } from "@/lib/quote-attachments";
import { useTaskBoard } from "@/lib/task-board-store";
import { sessionTaskLinks } from "@/lib/task-board-api";
import { usePartnerRoster } from "@/hooks/usePartnerRoster";
import { usePartnerGroups } from "@/hooks/usePartnerGroups";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import { useCapabilityLabel } from "@/features/ui-layout/tokens";
import { usePageCustomization } from "@/context/PageCustomizationContext";
import { useUiLayout } from "@/hooks/useUiLayout";
import ChatSpaceMenu from "@/components/chat/space/ChatSpaceMenu";

import AttachmentProcessingStatus from "./AttachmentProcessingStatus";
import styles from "./ChatComposer.module.css";
import { ComposerInput, type ComposerInputHandle } from "./ComposerInput";
import ComposerResources from "./ComposerResources";
import { ComposerTray } from "./ComposerTray";
import { QuotedPassage } from "./QuotedPassage";
import ReminderButton from "./ReminderButton";
import SelectedResources from "./SelectedResources";
import { CapabilityMenu } from "./composer/CapabilityMenu";
import { ComposerActionButtons } from "./composer/ComposerActionButtons";
import {
  buildContextTreeItems,
  buildKnowledgeResourceItems,
  buildSpaceSelectionCounts,
  buildTrayConfig,
} from "./composer/composerContextHelpers";
import type { ChatComposerProps, SendState } from "./composer/types";
import { useComposerFocus } from "./composer/useComposerFocus";
import { useModelSelection } from "./composer/useModelSelection";
import { useWorkspaceDraftSync } from "./composer/useWorkspaceDraftSync";

export default memo(function ChatComposer({
  taskSessionId,
  draftTaskIds = [],
  onDraftTaskIdsChange: _onDraftTaskIdsChange,
  onTasksLinked,
  composerRef,
  capMenuRef,
  capBtnRef,
  spaceMenuRef,
  spaceBtnRef,
  dragCounter,
  dragging,
  capMenuOpen,
  workspaceId = "",
  spaceMenuOpen,
  hasMessages,
  attachments,
  attachmentError,
  attachmentProcessing = [],
  activeCap,
  knowledgeBases,
  connectedAgents = [],
  selectedPartner = null,
  onSelectPartner,
  selectedPartnerGroup = null,
  onSelectPartnerGroup,
  answerBy = null,
  onAnswerByChange,
  selectedAgent = null,
  onSelectAgent,
  subagentBudget = null,
  onSubagentBudgetChange,
  llmOptions,
  activeLLMDefault,
  llmSelection,
  llmOptionsLoading,
  llmOptionsError,
  onRefreshLLMOptions,
  contextBudget = null,
  selectedNotebookRecords,
  selectedBookReferences,
  selectedReadingReferences = [],
  selectedHistorySessions,
  selectedAgentSessions,
  selectedQuestionEntries,
  notebookReferenceGroups,
  selectedPersona,
  selectedMemoryFiles,
  selectedKnowledgeBases,
  isStreaming,
  awaitingUserReply = false,
  isVisualizeMode,
  capabilityNeedsConfig,
  capabilityConfigConfirmed,
  onRequestConfigConfirm,
  capabilities: allCapabilities,
  customizable = false,
  onSetCapMenuOpen,
  onSetSpaceMenuOpen,
  onToggleKB,
  onSelectLLM,
  onSelectNotebookPicker,
  onSelectBookPicker,
  onSelectReadingPicker,
  onSelectHistoryPicker,
  onSelectAgentsPicker,
  onSelectQuestionBankPicker,
  onSelectPersonaPicker,
  onSelectMemoryPicker,
  onClearPersona,
  personaSelection: _personaSelection,
  onPersonaSelectionChange,
  personaSelectorOpen,
  onPersonaSelectorOpenChange,
  resourceCatalog,
  resourceSelection,
  onResourceSelectionChange,
  createTarget = null,
  onCreateTargetChange,
  agentsAvailable = true,
  onToggleMemoryFile,
  onSend,
  onRemoveAttachment,
  onPreviewAttachment,
  onRemoveHistory,
  onRemoveAgent,
  onRemoveBookReference,
  onRemoveReadingReference,
  onRemoveNotebook,
  onRemoveQuestion,
  onDragEnter,
  onDragLeave,
  onDragOver,
  onDrop,
  onPaste,
  onAddFiles,
  onSelectCapability,
  onCancelStreaming,
  prefillInputRef,
  focusInputRef,
  queueWhileStreaming = false,
  inputFooter,
  inputPlaceholder,
  inputPlaceholderCompletion,
  inputHeader,
  showCapabilityChip = true,
  docked = false,
  trayEnd,
}: ChatComposerProps) {
  
  const capabilityLabel = useCapabilityLabel();
  const { value: pageCustomization } = usePageCustomization();
  const controls = customizable ? pageCustomization.chat.controls : undefined;
  const capabilities = customizable
    ? allCapabilities.filter(
        (cap) => !pageCustomization.chat.hidden_modes.includes(cap.value),
      )
    : allCapabilities;
  // The modern layout picks the mode in the tray and writes it at the start
  // of the message; the classic one keeps its chip in the toolbar.
  const modeInTray = useUiLayout() === "modern" && showCapabilityChip;
  const canSelectPartner = Boolean(onSelectPartner || onAnswerByChange);
  const canSelectGroup = Boolean(onSelectPartnerGroup);
  const {
    partners,
    loading: partnersLoading,
    error: partnerLoadError,
  } = usePartnerRoster(canSelectPartner);
  const {
    groups: partnerGroups,
    loading: groupsLoading,
    error: groupLoadError,
  } = usePartnerGroups(canSelectGroup);

  const [hasContent, setHasContent] = useState(false);
  const inputHandleRef = useRef<ComposerInputHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { notifyDraftTextChange, clearDraftOnSend } = useWorkspaceDraftSync({
    attachments,
    onAddFiles,
    inputHandleRef,
  });

  const { textareaRef, focusTextarea } = useComposerFocus({
    hasMessages,
    focusInputRef,
  });

  const { effortModelOption, handleSelectLLM, handleSelectReasoningEffort } =
    useModelSelection({
      llmOptions,
      activeLLMDefault,
      llmSelection,
      onSelectLLM,
    });

  useEffect(() => {
    if (!prefillInputRef) return;
    prefillInputRef.current = (text: string) => {
      inputHandleRef.current?.setValue(text);
    };
    return () => {
      if (prefillInputRef) prefillInputRef.current = null;
    };
  }, [prefillInputRef]);

  // Microphone → speech-to-text. Appends the transcript to whatever is already
  // in the composer so a dictated phrase can be combined with typed text.
  const handleTranscript = useCallback((text: string) => {
    const current = inputHandleRef.current?.getValue() || "";
    const next = current.trim() ? `${current.trimEnd()} ${text}` : text;
    inputHandleRef.current?.setValue(next);
  }, []);
  const recorder = useVoiceRecorder(handleTranscript);

  const handlePickFiles = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const picked = Array.from(event.target.files ?? []);
      if (picked.length) onAddFiles(picked);
      // Reset so picking the same file twice still triggers `change`.
      event.target.value = "";
    },
    [onAddFiles],
  );

  // Functional-update form keeps `handleInputChange` identity stable across
  // every keystroke (no `hasContent` in deps), so the memoized ComposerInput
  // doesn't get re-rendered just because we observed a content-empty toggle.
  const handleInputChange = useCallback(
    (val: string) => {
      const next = !!val.trim();
      setHasContent((prev) => (prev === next ? prev : next));
      notifyDraftTextChange(val);
    },
    [notifyDraftTextChange],
  );

  const doSend = useCallback(
    (content: string) => {
      // Keyboard and button submissions share the same admission checks.
      // A refused submission must leave the draft in the input.
      if (isStreaming && !awaitingUserReply) return false;
      if (capabilityNeedsConfig && !capabilityConfigConfirmed) {
        onRequestConfigConfirm();
        return false;
      }
      onSend(content);
      setHasContent(false);
      clearDraftOnSend();
      // Sending can move focus to the button or rerender the empty-state
      // composer into the conversation layout. Restore it after that update
      // so the user can keep typing, including after switching back to the tab.
      focusTextarea();
      return true;
    },
    [
      awaitingUserReply,
      capabilityConfigConfirmed,
      capabilityNeedsConfig,
      clearDraftOnSend,
      focusTextarea,
      isStreaming,
      onRequestConfigConfirm,
      onSend,
    ],
  );

  const { board: taskBoard } = useTaskBoard();
  const linkedTaskIds = taskSessionId
    ? sessionTaskLinks(taskBoard, taskSessionId, workspaceId ?? "")?.task_ids ??
      []
    : draftTaskIds;
  const taskPanelPending = useRef(false);
  useEffect(() => {
    // Let users finish selecting tasks before the viewer changes the layout.
    if (taskPanelPending.current && !spaceMenuOpen && !personaSelectorOpen) {
      taskPanelPending.current = false;
      onTasksLinked?.();
    }
  }, [spaceMenuOpen, personaSelectorOpen, onTasksLinked]);

  const hasReferences =
    !!linkedTaskIds.length ||
    !!attachments.length ||
    !!selectedBookReferences.length ||
    !!selectedReadingReferences.length ||
    !!selectedNotebookRecords.length ||
    !!selectedHistorySessions.length ||
    !!selectedAgentSessions.length ||
    !!selectedQuestionEntries.length ||
    !!selectedPersona ||
    !!selectedMemoryFiles.length;

  // `capabilityNeedsConfig && !capabilityConfigConfirmed` blocks send so the
  // user has to click *Confirm* in the right-side Activity panel first.
  // Clicking the send button while in this state surfaces the config card
  // (via `onRequestConfigConfirm`) instead of silently doing nothing.
  const isConfigBlocked = capabilityNeedsConfig && !capabilityConfigConfirmed;
  const hasIntent = hasContent || hasReferences;
  // A turn paused on a question is technically still streaming, but the only
  // thing that can move it forward is the user's answer. Locking the composer
  // there made the interactive card the ONLY way to answer — and left the
  // learner with no way out at all if the card failed to render.
  // Where the surface can hold messages for a running turn, a message typed
  // mid-turn is sent (queued) and Stop moves to a button of its own.
  const queuing =
    Boolean(queueWhileStreaming) && isStreaming && !awaitingUserReply;
  const streamingBlocksSend =
    isStreaming && !awaitingUserReply && !(queuing && hasIntent);
  const canSend = hasIntent && !streamingBlocksSend && !isConfigBlocked;

  // `blocked` only exists once there is intent: without it the button stays
  // `idle` so an empty composer doesn't present a live send affordance. That
  // makes intent — not `canSend` — the thing that decides interactivity, so
  // the `blocked` state can stay clickable and surface the config card.
  const sendState: SendState = streamingBlocksSend
    ? "streaming"
    : !hasIntent
      ? "idle"
      : isConfigBlocked
        ? "blocked"
        : "ready";

  const spaceSelectionCounts = buildSpaceSelectionCounts({
    attachments,
    selectedKnowledgeBases,
    selectedHistorySessions,
    selectedAgentSessions,
    selectedBookReferences,
    selectedReadingReferences,
    selectedNotebookRecords,
    selectedQuestionEntries,
    selectedPersona,
    selectedMemoryFiles,
  });

  // One selection summary for files, references, and conversation resources.
  const contextTreeItems = buildContextTreeItems({
    attachments,
    selectedKnowledgeBases,
    knowledgeBases,
    selectedBookReferences,
    selectedReadingReferences,
    notebookReferenceGroups,
    selectedHistorySessions,
    selectedAgentSessions,
    selectedQuestionEntries,
    selectedPersona,
    selectedMemoryFiles,
    onPreviewAttachment,
    onRemoveAttachment,
    onToggleKB,
    onRemoveBookReference,
    onRemoveReadingReference,
    onRemoveNotebook,
    onRemoveHistory,
    onRemoveAgent,
    onRemoveQuestion,
    onClearPersona,
    onToggleMemoryFile,
  });

  const {
    createKindDef,
    leadTokens,
    trayMode,
    trayCreate,
    answerMode,
    partnerLinks,
  } = buildTrayConfig({
    capabilityLabel,
    modeInTray,
    activeCap,
    capabilities,
    onSelectCapability,
    createTarget,
    onCreateTargetChange,
    resourceSelection,
    onResourceSelectionChange,
    onPersonaSelectionChange,
    personaSelectorOpen,
    onPersonaSelectorOpenChange,
    answerBy,
    onAnswerByChange,
    connectedAgents,
    selectedAgent,
    onSelectAgent,
    subagentBudget,
    onSubagentBudgetChange,
    partners,
    partnersLoading,
    partnerLoadError,
    selectedPartner,
    onSelectPartner,
    partnerGroups,
    groupsLoading,
    groupLoadError,
    selectedPartnerGroup,
    onSelectPartnerGroup,
  });

  const handleManualSend = useCallback(() => {
    if (isConfigBlocked) {
      // Don't silently fail — surface the config card so the user knows
      // they need to confirm settings first.
      onRequestConfigConfirm();
      return;
    }
    if (!canSend) return;
    const content = inputHandleRef.current?.getValue() || "";
    doSend(content);
  }, [canSend, doSend, isConfigBlocked, onRequestConfigConfirm]);

  // One button, so one handler: mid-turn the same control cancels — except
  // while the turn is waiting on the user, where sending IS how it continues.
  const handleSendButtonClick = useCallback(() => {
    if (streamingBlocksSend) {
      onCancelStreaming();
      return;
    }
    handleManualSend();
  }, [handleManualSend, streamingBlocksSend, onCancelStreaming]);

  const sendLabel =
    sendState === "streaming"
      ? "Stop generating"
      : awaitingUserReply
        ? "Send answer"
        : queuing
          ? "Queue message"
          : "Send";
  const sendTitle =
    sendState === "blocked"
      ? "Confirm settings on the right to send."
      : sendLabel;

  const resourceItems = buildKnowledgeResourceItems({
    knowledgeBases,
    selectedKnowledgeBases,
    onToggleKB,
  });

  return (
    <div
      ref={composerRef}
      className={`relative ${spaceMenuOpen || personaSelectorOpen ? "z-[61]" : "z-20"} mx-auto w-full shrink-0 ${
        // Docked in a pane: the pane is the frame, so the composer keeps a
        // narrow margin instead of the page's wide gutter.
        docked
          ? "px-3 pb-3 pt-1"
          : `px-6 pb-5 ${hasMessages ? "pt-1 max-w-[960px]" : "max-w-[768px]"}`
      }`}
      style={{
        transition: "max-width 650ms cubic-bezier(0.16, 1, 0.3, 1)",
      }}
    >
      {hasMessages && !docked && (
        <div className="pointer-events-none absolute inset-x-0 top-0 h-6 bg-gradient-to-b from-transparent to-[var(--background)]/72" />
      )}

      <div className="relative">
        <div
          className={`${styles.surface} dt-composer-surface relative rounded-[26px] border bg-[var(--card)] shadow-[0_1px_2px_rgba(0,0,0,0.025),0_10px_28px_-10px_rgba(0,0,0,0.08)] transition-colors ${
            dragging
              ? "border-[var(--primary)] bg-[var(--primary)]/[0.03]"
              : "border-[var(--border)]/55"
          }`}
          onDragEnter={onDragEnter}
          onDragLeave={onDragLeave}
          onDragOver={onDragOver}
          onDrop={onDrop}
          data-drag-counter={dragCounter.current}
        >
          {dragging && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[26px] border-2 border-dashed border-[var(--primary)]/50 bg-[var(--primary)]/[0.04]">
              <div className="flex flex-col items-center gap-1 text-[var(--primary)]">
                <Paperclip size={22} strokeWidth={1.6} />
                <span className="text-[13px] font-medium">
                  {"Drop files here"}
                </span>
                <span className="text-[11px] text-[var(--primary)]/70">
                  {"Images, Office docs, code & text"}
                </span>
              </div>
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ATTACHMENT_ACCEPT}
            onChange={handleFileInputChange}
            className="hidden"
            aria-hidden="true"
            tabIndex={-1}
          />

          {inputHeader}
          {attachments.map((file, index) =>
            isQuoteAttachment(file) ? (
              <QuotedPassage
                key={`quote-${index}`}
                quote={quoteText(file)}
                onRemove={() => onRemoveAttachment(index)}
              />
            ) : null,
          )}
          <SelectedResources items={contextTreeItems} />
          <AttachmentProcessingStatus items={attachmentProcessing} />
          {inputFooter}
          <ComposerInput
            ref={inputHandleRef}
            textareaRef={textareaRef}
            isVisualizeMode={isVisualizeMode}
            isStreaming={streamingBlocksSend}
            canSendEmpty={hasReferences}
            onSend={doSend}
            onInputChange={handleInputChange}
            onPaste={onPaste}
            connectedAgents={connectedAgents}
            selectedAgent={selectedAgent}
            onSelectAgent={onSelectAgent}
            selectedCounts={spaceSelectionCounts}
            knowledgeAvailable={false}
            personaAvailable={false}
            onSelectAttach={handlePickFiles}
            agentsAvailable={agentsAvailable}
            onSelectNotebookPicker={onSelectNotebookPicker}
            onSelectBookPicker={onSelectBookPicker}
            onSelectReadingPicker={onSelectReadingPicker}
            onSelectHistoryPicker={onSelectHistoryPicker}
            onSelectAgentsPicker={onSelectAgentsPicker}
            onSelectQuestionBankPicker={onSelectQuestionBankPicker}
            onSelectPersonaPicker={() => {}}
            onSelectMemoryPicker={onSelectMemoryPicker}
            onOpenPersonaSelector={undefined}
            placeholder={
              inputPlaceholder ??
              (createKindDef ? (createKindDef.placeholderKey) : undefined)
            }
            placeholderCompletion={inputPlaceholderCompletion}
            minHeight={hasMessages || docked ? 28 : 64}
            lead={leadTokens}
          />

          {attachmentError && (
            <div className="px-4 pb-2 text-[11px] text-red-600">
              {attachmentError}
            </div>
          )}

          {recorder.error && (
            <div role="alert" className="px-4 pb-2 text-[11px] text-red-600">
              {recorder.error}
            </div>
          )}

          {/* Claude-style chrome-free toolbar: no divider against the input
              area, no pill borders — quiet text/icon buttons that surface
              on hover. */}
          <div className="px-3 pb-2 pt-0.5">
            <div className={styles.toolbar}>
              <div className={styles.context}>
                <ComposerResources
                  selectedCount={contextTreeItems.length}
                  items={resourceItems}
                  open={spaceMenuOpen}
                  onOpenChange={onSetSpaceMenuOpen}
                  onBack={() => {}}
                  triggerRef={spaceBtnRef}
                  panelRef={spaceMenuRef}
                  materials={(query) => (
                    <ChatSpaceMenu
                      variant="resources"
                      query={query}
                      selectedCounts={spaceSelectionCounts}
                      knowledgeAvailable={false}
                      personaAvailable={false}
                      agentsAvailable={agentsAvailable}
                      readingAvailable={Boolean(onSelectReadingPicker)}
                      onSelectItem={(key) => {
                        onSetSpaceMenuOpen(false);
                        if (key === "attach") handlePickFiles();
                        else if (key === "chat_history")
                          onSelectHistoryPicker();
                        else if (key === "my_agents") onSelectAgentsPicker();
                        else if (key === "books") onSelectBookPicker();
                        else if (key === "reading") onSelectReadingPicker?.();
                        else if (key === "notebooks") onSelectNotebookPicker();
                        else if (key === "question_bank")
                          onSelectQuestionBankPicker();
                        else if (key === "persona") onSelectPersonaPicker();
                        else if (key === "memory") onSelectMemoryPicker();
                      }}
                    />
                  )}
                />

                {showCapabilityChip && !modeInTray && (
                  <CapabilityMenu
                    activeCap={activeCap}
                    capabilities={capabilities}
                    capMenuOpen={capMenuOpen}
                    capBtnRef={capBtnRef}
                    capMenuRef={capMenuRef}
                    onSetCapMenuOpen={onSetCapMenuOpen}
                    onSelectCapability={onSelectCapability}
                  />
                )}
              </div>

              <ReminderButton />

              <ComposerActionButtons
                llmOptions={llmOptions}
                activeLLMDefault={activeLLMDefault}
                llmSelection={llmSelection}
                llmOptionsLoading={llmOptionsLoading}
                llmOptionsError={llmOptionsError}
                onSelectLLM={handleSelectLLM}
                onRefreshLLMOptions={onRefreshLLMOptions}
                effortModelOption={effortModelOption}
                onSelectReasoningEffort={handleSelectReasoningEffort}
                contextBudget={contextBudget}
                showVoiceControl={controls?.voice !== false}
                recorderState={recorder.state}
                recorderError={recorder.error}
                onToggleRecorder={recorder.toggle}
                isStreaming={isStreaming}
                queuing={queuing}
                hasIntent={hasIntent}
                onCancelStreaming={onCancelStreaming}
                sendState={sendState}
                sendTitle={sendTitle}
                sendLabel={sendLabel}
                onSendButtonClick={handleSendButtonClick}
              />
            </div>
          </div>
        </div>
        {trayMode ||
        (resourceCatalog && resourceSelection && onResourceSelectionChange) ||
        trayCreate ||
        answerMode ||
        partnerLinks ||
        trayEnd ? (
          <ComposerTray
            controls={controls}
            placement={hasMessages || docked ? "up" : "down"}
            mode={trayMode}
            resources={
              resourceCatalog &&
              resourceSelection &&
              onResourceSelectionChange
                ? {
                    catalog: resourceCatalog,
                    selection: resourceSelection,
                    onChange: onResourceSelectionChange,
                  }
                : undefined
            }
            create={trayCreate}
            partners={partnerLinks}
            answer={answerMode}
            end={trayEnd}
          />
        ) : null}
      </div>
    </div>
  );
});
