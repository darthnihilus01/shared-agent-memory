import {
  recordCaptureStatus,
  readCaptureStatuses,
  pendingForSession,
} from './status.ts';
import type { SessionKey } from '../../contracts/src/conversations.ts';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  capture,
  flush,
  recallInstruction,
  selectionInstruction,
} from './hooks.ts';
import type { ClientName } from './hooks.ts';
import { resolveScope, resolveConnection } from './scope.ts';
import { captureTranscript } from './transcript.ts';
import { MemoryStore } from '../../memory/src/store.ts';

const [action, client] = process.argv.slice(2);
let captureSession: SessionKey | undefined;
let capturedAt: string | null = null;
let captureState:
  | 'unobserved'
  | 'captured'
  | 'partial'
  | 'no_supported_text'
  | 'no_new_text'
  | 'error' = 'unobserved';
let selectedSessionToken: string | undefined;
const statusDirectory = process.env.MEMORY_QUEUE ?? resolve('.memory/queue');
try {
  if (!['claude', 'codex', 'antigravity'].includes(client ?? ''))
    throw new Error('Choose claude, codex or antigravity');
  let payload: Record<string, unknown> = {};
  if (action === 'capture' || action === 'recall') {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) throw new Error('Hook input exceeds 1 MiB');
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (text) {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('Hook input must be an object');
      payload = parsed;
    }
  }
  let scope;
  let selectedSessionId: string | undefined;
  const conversationMode = process.env.MEMORY_CONVERSATION_MODE === '1';
  if (conversationMode && action !== 'flush') {
    const { repoId, workspace } = resolveConnection(payload);
    const nativeSessionId = payload.session_id ?? payload.conversationId;
    if (typeof nativeSessionId !== 'string' || !nativeSessionId)
      throw new Error('A native session ID is required');
    selectedSessionId = nativeSessionId;
    captureSession = { repoId, client, nativeSessionId };
    const path = process.env.MEMORY_DB ?? resolve('.memory/events.sqlite');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const store = new MemoryStore(path, { conversationMode: true });
    try {
      if (
        process.env.MEMORY_CAPTURE_NEW_SESSIONS !== '1' &&
        !store.sessionSelection(repoId, nativeSessionId)
      ) {
        console.log(
          action === 'recall'
            ? JSON.stringify(
                selectionInstruction(
                  client as ClientName,
                  repoId,
                  nativeSessionId,
                  workspace,
                ),
              )
            : '{}',
        );
        process.exit(0);
      }
      const git = (args: string[]) => {
        try {
          return (
            execFileSync('git', args, {
              cwd: workspace,
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'ignore'],
            }).trim() || undefined
          );
        } catch {
          return undefined;
        }
      };
      const branch = git(['symbolic-ref', '--short', 'HEAD']),
        commit = git(['rev-parse', 'HEAD']);
      const conversation = store.ensureSession(
        { repoId, client, nativeSessionId },
        { workspace, branch, commit },
      );
      if (
        action === 'recall' &&
        process.env.MEMORY_LAUNCH_FEATURE?.startsWith('conversation:')
      )
        store.linkSource(
          { repoId, client, nativeSessionId },
          process.env.MEMORY_LAUNCH_FEATURE,
        );
      if (action === 'recall') {
        selectedSessionToken = store.issueSessionToken(captureSession);
        if (
          !readCaptureStatuses(statusDirectory).some(
            (s) =>
              s.session.repoId === repoId &&
              s.session.client === client &&
              s.session.nativeSessionId === nativeSessionId,
          )
        )
          recordCaptureStatus(statusDirectory, {
            session: captureSession,
            lastCaptureAt: null,
            lastDeliveryAt: null,
            pending: pendingForSession(statusDirectory, captureSession),
            lastErrorCode: null,
            captureState: 'unobserved',
          });
      }
      scope = {
        repoId,
        featureId: conversation.conversationId,
        branch,
        commit,
      };
    } finally {
      store.close();
    }
  } else if (
    process.env.MEMORY_SESSION_SELECTION === '1' &&
    action !== 'flush'
  ) {
    const { repoId, workspace } = resolveConnection(payload);
    const sessionId = payload.session_id ?? payload.conversationId;
    if (typeof sessionId !== 'string' || !sessionId)
      throw new Error('A native session ID is required for chat selection');
    selectedSessionId = sessionId;
    const path = process.env.MEMORY_DB ?? resolve('.memory/events.sqlite');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const store = new MemoryStore(path);
    let selection;
    try {
      selection = store.sessionSelection(repoId, sessionId);
      if (!selection && process.env.MEMORY_LAUNCH_FEATURE) {
        store.selectSession(
          repoId,
          sessionId,
          process.env.MEMORY_LAUNCH_FEATURE,
          process.env.MEMORY_LAUNCH_TITLE ?? 'Selected chat',
        );
        selection = store.sessionSelection(repoId, sessionId);
      }
    } finally {
      store.close();
    }
    if (!selection) {
      if (action === 'recall')
        console.log(
          JSON.stringify(
            selectionInstruction(
              client as ClientName,
              repoId,
              sessionId,
              workspace,
              process.env.MEMORY_MCP_SERVER,
            ),
          ),
        );
      else {
        console.error(
          'Shared memory: no chat selected for this session; capture skipped',
        );
        console.log('{}');
      }
      process.exit(0);
    }
    scope = { repoId, featureId: selection.featureId };
  } else scope = resolveScope(payload);
  if (action === 'recall') {
    console.log(
      JSON.stringify(
        recallInstruction(
          client as ClientName,
          scope,
          process.env.MEMORY_WORKSPACE,
          selectedSessionId,
          selectedSessionToken,
          process.env.MEMORY_MCP_SERVER,
        ),
      ),
    );
  } else if (action === 'capture' || action === 'flush') {
    const directory = statusDirectory;
    if (action === 'capture') {
      const transcriptPath = payload.transcript_path ?? payload.transcriptPath;
      if (typeof transcriptPath === 'string' && transcriptPath) {
        const report = captureTranscript({
          directory,
          client: client as ClientName,
          scope,
          sessionId: String(payload.session_id ?? payload.conversationId ?? ''),
          path: transcriptPath,
          ...(conversationMode ? { session: captureSession } : {}),
        });
        console.error(JSON.stringify(report));
        if (report.events > 0) capturedAt = new Date().toISOString();
        captureState =
          report.remainingBytes > 0
            ? 'partial'
            : report.events > 0
              ? 'captured'
              : report.records > 0
                ? 'no_supported_text'
                : 'no_new_text';
      } else {
        capture(
          directory,
          client as ClientName,
          scope,
          payload,
          conversationMode ? captureSession : undefined,
        );
        capturedAt = new Date().toISOString();
        captureState = 'captured';
      }
    }
    const touched = new Map<
      string,
      { session: SessionKey; delivered: boolean }
    >();
    if (captureSession)
      touched.set(JSON.stringify(captureSession), {
        session: captureSession,
        delivered: false,
      });
    const report = flush(directory, (event, queuedSession) => {
      if (queuedSession) {
        if (
          event.repoId !== queuedSession.repoId ||
          event.sessionId !== queuedSession.nativeSessionId ||
          !event.source?.startsWith(queuedSession.client + ':')
        )
          throw new Error('Queued evidence identity mismatch');
        const id = JSON.stringify(queuedSession);
        if (!touched.has(id))
          touched.set(id, { session: queuedSession, delivered: false });
      }
      const path = process.env.MEMORY_DB ?? resolve('.memory/events.sqlite');
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const store = new MemoryStore(path, {
        conversationMode: !!queuedSession,
      });
      try {
        if (queuedSession) store.appendEvidence(queuedSession, event);
        else store.save(event);
      } finally {
        store.close();
      }
      if (queuedSession)
        touched.get(JSON.stringify(queuedSession))!.delivered = true;
    });
    for (const { session, delivered } of touched.values()) {
      const ownCapture =
        action === 'capture' &&
        captureSession &&
        JSON.stringify(session) === JSON.stringify(captureSession);
      const previous = readCaptureStatuses(directory).find(
        (s) => JSON.stringify(s.session) === JSON.stringify(session),
      );
      const pending = pendingForSession(directory, session);
      recordCaptureStatus(directory, {
        session,
        lastCaptureAt: ownCapture ? capturedAt : null,
        lastDeliveryAt: delivered ? new Date().toISOString() : null,
        pending,
        lastErrorCode: pending ? 'DELIVERY_PENDING' : null,
        lastAttemptAt: ownCapture ? new Date().toISOString() : null,
        captureState: ownCapture
          ? captureState
          : (previous?.captureState ?? 'unobserved'),
      });
    }
    console.error(JSON.stringify(report));
    console.log('{}');
  } else throw new Error('Choose capture, recall or flush');
} catch (error) {
  if (action === 'capture' && captureSession) {
    try {
      recordCaptureStatus(statusDirectory, {
        session: captureSession,
        lastCaptureAt: capturedAt,
        lastDeliveryAt: null,
        pending: pendingForSession(statusDirectory, captureSession),
        lastErrorCode: 'CAPTURE_FAILED',
        lastAttemptAt: new Date().toISOString(),
        captureState: 'error',
      });
    } catch {
      /* The data path itself may be unavailable; stderr still reports failure. */
    }
  }
  // Hook failure must not prevent the user's coding turn.
  console.error(
    'Shared memory: ' +
      (error instanceof Error ? error.message : String(error)),
  );
  if (action === 'recall' && process.env.MEMORY_WORKSPACE) {
    const message =
      'Memory handoff blocked. ' +
      (error instanceof Error ? error.message : String(error));
    console.log(
      JSON.stringify({
        continue: false,
        systemMessage: message,
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext:
            message +
            ' Do not continue imported work or edit another project from this chat.',
        },
      }),
    );
  } else console.log('{}');
}
