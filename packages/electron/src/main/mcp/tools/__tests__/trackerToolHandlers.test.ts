import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
}));

vi.mock('../../../database/initialize', () => ({
  getDatabase: () => ({
    query: mockQuery,
  }),
}));

vi.mock('../../../services/TrackerIdentityService', () => ({
  getCurrentIdentity: vi.fn(() => ({ displayName: 'Test User' })),
}));

vi.mock('../../../services/TrackerPolicyService', () => ({
  getEffectiveTrackerSyncPolicy: vi.fn(() => ({ mode: 'local', scope: 'project' })),
  getInitialTrackerSyncStatus: vi.fn(() => 'local'),
  shouldSyncTrackerPolicy: vi.fn(() => false),
}));

vi.mock('../../../services/TrackerSyncManager', () => ({
  isTrackerSyncActive: vi.fn(() => false),
  syncTrackerItem: vi.fn(),
}));

vi.mock('../../../services/TrackerSchemaService', () => ({
  getTrackerRoleField: vi.fn(() => null),
}));

vi.mock('../../../utils/store', () => ({
  getWorkspaceState: vi.fn(() => ({ issueKeyPrefix: 'NIM' })),
}));

vi.mock('../../../window/WindowManager', () => ({
  findWindowByWorkspace: vi.fn(() => null),
  documentServices: new Map(),
}));

vi.mock('@nimbalyst/runtime/plugins/TrackerPlugin/models/TrackerDataModel', () => ({
  globalRegistry: { get: vi.fn(() => undefined) },
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

import {
  handleTrackerCreate,
  handleTrackerGet,
  handleTrackerLinkSession,
  handleTrackerUnlinkSession,
} from '../trackerToolHandlers';

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bug_internal',
    issue_key: 'NIM-1',
    issue_number: 1,
    type: 'bug',
    type_tags: ['bug'],
    data: JSON.stringify({
      title: 'Scoped bug',
      status: 'to-do',
      priority: 'high',
    }),
    updated: '2026-04-02T00:00:00.000Z',
    ...overrides,
  };
}

describe('handleTrackerGet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('scopes issue key lookups to the active workspace', async () => {
    mockQuery.mockResolvedValue({
      rows: [makeRow({ workspace: '/tmp/workspace-a' })],
    });

    const result = await handleTrackerGet({ id: 'NIM-1' }, '/tmp/workspace-a');

    expect(result.isError).toBe(false);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('WHERE (id = $1 OR issue_key = $1) AND workspace = $2'),
      ['NIM-1', '/tmp/workspace-a'],
    );
  });
});

describe('handleTrackerCreate session linking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Drive every query handleTrackerCreate makes through one queue. The handler
  // doesn't care about return shapes for the writes; the reads need just enough
  // to keep it walking through the create flow.
  function setupCreateQueueWithoutLink() {
    const createdRow = makeRow({
      id: 'bug_test',
      workspace: '/tmp/ws',
      issue_key: null,
      issue_number: null,
    });
    mockQuery
      .mockResolvedValueOnce({ rows: [] })                              // INSERT
      .mockResolvedValueOnce({ rows: [createdRow] })                    // resolve created
      .mockResolvedValueOnce({ rows: [{ max_num: 0 }] })                // MAX(issue_number)
      .mockResolvedValueOnce({ rows: [] })                              // UPDATE issue_key
      .mockResolvedValueOnce({ rows: [{ ...createdRow, issue_key: 'NIM-1', issue_number: 1 }] }) // re-resolve
      .mockResolvedValueOnce({ rows: [{ ...createdRow, issue_key: 'NIM-1', issue_number: 1 }] }); // notifyTrackerItemAdded
  }

  it('does NOT auto-link the current session when linkSession is omitted', async () => {
    setupCreateQueueWithoutLink();

    const result = await handleTrackerCreate(
      { type: 'bug', title: 'Some bug' },
      '/tmp/ws',
      'session_abc',
    );

    expect(result.isError).toBe(false);
    const sqls = mockQuery.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('UPDATE ai_sessions'))).toBe(false);
    expect(sqls.some((s) => s.includes('SELECT metadata FROM ai_sessions'))).toBe(false);
  });

  it('links the current session when linkSession: true', async () => {
    const createdRow = makeRow({
      id: 'bug_test',
      workspace: '/tmp/ws',
      issue_key: null,
      issue_number: null,
    });
    mockQuery
      .mockResolvedValueOnce({ rows: [] })                              // INSERT
      .mockResolvedValueOnce({ rows: [createdRow] })                    // resolve created
      .mockResolvedValueOnce({ rows: [{ max_num: 0 }] })                // MAX(issue_number)
      .mockResolvedValueOnce({ rows: [] })                              // UPDATE issue_key
      .mockResolvedValueOnce({ rows: [{ ...createdRow, issue_key: 'NIM-1', issue_number: 1 }] }) // re-resolve
      // createBidirectionalLink:
      .mockResolvedValueOnce({ rows: [{ data: {} }] })                  // SELECT data FROM tracker_items
      .mockResolvedValueOnce({ rows: [] })                              // UPDATE tracker_items
      .mockResolvedValueOnce({ rows: [{ metadata: {} }] })              // SELECT metadata FROM ai_sessions
      .mockResolvedValueOnce({ rows: [] })                              // UPDATE ai_sessions
      // notifySessionLinkedTrackerChanged read:
      .mockResolvedValueOnce({ rows: [{ metadata: { linkedTrackerItemIds: ['bug_test'] } }] })
      // notifyTrackerItemAdded:
      .mockResolvedValueOnce({ rows: [{ ...createdRow, issue_key: 'NIM-1', issue_number: 1 }] });

    const result = await handleTrackerCreate(
      { type: 'bug', title: 'Some bug', linkSession: true },
      '/tmp/ws',
      'session_abc',
    );

    expect(result.isError).toBe(false);
    const sqls = mockQuery.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('UPDATE ai_sessions'))).toBe(true);
  });

  it('does NOT link when linkSession: true but no session is active', async () => {
    setupCreateQueueWithoutLink();

    const result = await handleTrackerCreate(
      { type: 'bug', title: 'Some bug', linkSession: true },
      '/tmp/ws',
      undefined,
    );

    expect(result.isError).toBe(false);
    const sqls = mockQuery.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('UPDATE ai_sessions'))).toBe(false);
  });
});

describe('handleTrackerLinkSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('links the explicit target sessionId, not the ambient session', async () => {
    const trackerRow = makeRow({ id: 'bug_target', workspace: '/tmp/ws' });
    mockQuery
      // resolveTrackerRowByReference (existing item lookup)
      .mockResolvedValueOnce({ rows: [trackerRow] })
      // explicit-session existence check
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      // createBidirectionalLink: SELECT data FROM tracker_items
      .mockResolvedValueOnce({ rows: [{ data: {} }] })
      // createBidirectionalLink: UPDATE tracker_items
      .mockResolvedValueOnce({ rows: [] })
      // createBidirectionalLink: SELECT metadata FROM ai_sessions
      .mockResolvedValueOnce({ rows: [{ metadata: {} }] })
      // createBidirectionalLink: UPDATE ai_sessions
      .mockResolvedValueOnce({ rows: [] })
      // post-link SELECT data FROM tracker_items (for linkedSessions count)
      .mockResolvedValueOnce({ rows: [{ data: { linkedSessions: ['session_explicit'] } }] })
      // notifyTrackerItemUpdated read
      .mockResolvedValueOnce({ rows: [trackerRow] })
      // notifySessionLinkedTrackerChanged read
      .mockResolvedValueOnce({ rows: [{ metadata: { linkedTrackerItemIds: ['bug_target'] } }] });

    const result = await handleTrackerLinkSession(
      { trackerId: 'NIM-1', sessionId: 'session_explicit' },
      'session_ambient',
      '/tmp/ws',
    );

    expect(result.isError).toBe(false);
    const updateSessionCalls = mockQuery.mock.calls.filter(
      (c) => String(c[0]).includes('UPDATE ai_sessions'),
    );
    expect(updateSessionCalls).toHaveLength(1);
    expect(updateSessionCalls[0][1]).toContain('session_explicit');
    expect(updateSessionCalls[0][1]).not.toContain('session_ambient');

    const payload = JSON.parse(result.content[0].text!);
    expect(payload.structured.sessionId).toBe('session_explicit');
  });

  it('falls back to the ambient session when sessionId is omitted', async () => {
    const trackerRow = makeRow({ id: 'bug_target', workspace: '/tmp/ws' });
    mockQuery
      .mockResolvedValueOnce({ rows: [trackerRow] })                              // resolveTrackerRowByReference
      .mockResolvedValueOnce({ rows: [{ data: {} }] })                            // SELECT data
      .mockResolvedValueOnce({ rows: [] })                                        // UPDATE tracker_items
      .mockResolvedValueOnce({ rows: [{ metadata: {} }] })                        // SELECT metadata
      .mockResolvedValueOnce({ rows: [] })                                        // UPDATE ai_sessions
      .mockResolvedValueOnce({ rows: [{ data: { linkedSessions: ['session_ambient'] } }] }) // post-link tracker read
      .mockResolvedValueOnce({ rows: [trackerRow] })                              // notifyTrackerItemUpdated
      .mockResolvedValueOnce({ rows: [{ metadata: { linkedTrackerItemIds: ['bug_target'] } }] });

    const result = await handleTrackerLinkSession(
      { trackerId: 'NIM-1' },
      'session_ambient',
      '/tmp/ws',
    );

    expect(result.isError).toBe(false);
    const sessionExistsChecks = mockQuery.mock.calls.filter((c) =>
      String(c[0]).includes('SELECT 1 FROM ai_sessions'),
    );
    expect(sessionExistsChecks).toHaveLength(0);

    const payload = JSON.parse(result.content[0].text!);
    expect(payload.structured.sessionId).toBe('session_ambient');
  });

  it('returns an error when an explicit sessionId does not exist', async () => {
    const trackerRow = makeRow({ id: 'bug_target', workspace: '/tmp/ws' });
    mockQuery
      // resolveTrackerRowByReference
      .mockResolvedValueOnce({ rows: [trackerRow] })
      // explicit session existence check returns no rows
      .mockResolvedValueOnce({ rows: [] });

    const result = await handleTrackerLinkSession(
      { trackerId: 'NIM-1', sessionId: 'session_missing' },
      undefined,
      '/tmp/ws',
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Session not found');
    const sqls = mockQuery.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('UPDATE ai_sessions'))).toBe(false);
    expect(sqls.some((s) => s.includes('UPDATE tracker_items'))).toBe(false);
  });
});

describe('handleTrackerUnlinkSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('unlinks the explicit target sessionId, not the ambient session', async () => {
    const trackerRow = makeRow({ id: 'bug_target', workspace: '/tmp/ws' });
    mockQuery
      .mockResolvedValueOnce({ rows: [trackerRow] }) // resolveTrackerRowByReference
      .mockResolvedValueOnce({ rows: [{ data: { linkedSessions: ['session_explicit', 'session_other'] } }] }) // SELECT data
      .mockResolvedValueOnce({ rows: [] }) // UPDATE tracker_items
      .mockResolvedValueOnce({ rows: [{ metadata: { linkedTrackerItemIds: ['bug_target', 'bug_other'] } }] }) // SELECT metadata
      .mockResolvedValueOnce({ rows: [] }) // UPDATE ai_sessions
      .mockResolvedValueOnce({ rows: [{ data: { linkedSessions: ['session_other'] } }] }) // post-unlink tracker read
      .mockResolvedValueOnce({ rows: [trackerRow] }) // notifyTrackerItemUpdated
      .mockResolvedValueOnce({ rows: [{ metadata: { linkedTrackerItemIds: ['bug_other'] } }] }); // notifySessionLinkedTrackerChanged read

    const result = await handleTrackerUnlinkSession(
      { trackerId: 'NIM-1', sessionId: 'session_explicit' },
      'session_ambient',
      '/tmp/ws',
    );

    expect(result.isError).toBe(false);
    const updateSessionCalls = mockQuery.mock.calls.filter(
      (c) => String(c[0]).includes('UPDATE ai_sessions'),
    );
    expect(updateSessionCalls).toHaveLength(1);
    expect(updateSessionCalls[0][1]).toContain('session_explicit');
    expect(updateSessionCalls[0][1]).not.toContain('session_ambient');

    const payload = JSON.parse(result.content[0].text!);
    expect(payload.structured.sessionId).toBe('session_explicit');
    expect(payload.structured.linkedCount).toBe(1);
    expect(payload.structured.removed).toBe(true);
  });

  it('falls back to the ambient session when sessionId is omitted', async () => {
    const trackerRow = makeRow({ id: 'bug_target', workspace: '/tmp/ws' });
    mockQuery
      .mockResolvedValueOnce({ rows: [trackerRow] }) // resolveTrackerRowByReference
      .mockResolvedValueOnce({ rows: [{ data: { linkedSessions: ['session_ambient'] } }] }) // SELECT data
      .mockResolvedValueOnce({ rows: [] }) // UPDATE tracker_items
      .mockResolvedValueOnce({ rows: [{ metadata: { linkedTrackerItemIds: ['bug_target'] } }] }) // SELECT metadata
      .mockResolvedValueOnce({ rows: [] }) // UPDATE ai_sessions
      .mockResolvedValueOnce({ rows: [{ data: {} }] }) // post-unlink tracker read
      .mockResolvedValueOnce({ rows: [trackerRow] }) // notifyTrackerItemUpdated
      .mockResolvedValueOnce({ rows: [{ metadata: {} }] }); // notifySessionLinkedTrackerChanged read

    const result = await handleTrackerUnlinkSession(
      { trackerId: 'NIM-1' },
      'session_ambient',
      '/tmp/ws',
    );

    expect(result.isError).toBe(false);
    const sessionExistsChecks = mockQuery.mock.calls.filter((c) =>
      String(c[0]).includes('SELECT 1 FROM ai_sessions'),
    );
    expect(sessionExistsChecks).toHaveLength(0);

    const payload = JSON.parse(result.content[0].text!);
    expect(payload.structured.sessionId).toBe('session_ambient');
    expect(payload.structured.linkedCount).toBe(0);
    expect(payload.structured.removed).toBe(true);
  });

  it('cleans the tracker side even when the explicit session no longer exists', async () => {
    const trackerRow = makeRow({ id: 'bug_target', workspace: '/tmp/ws' });
    mockQuery
      .mockResolvedValueOnce({ rows: [trackerRow] }) // resolveTrackerRowByReference
      .mockResolvedValueOnce({ rows: [{ data: { linkedSessions: ['session_missing'] } }] }) // SELECT data
      .mockResolvedValueOnce({ rows: [] }) // UPDATE tracker_items
      .mockResolvedValueOnce({ rows: [] }) // SELECT metadata (session missing)
      .mockResolvedValueOnce({ rows: [{ data: {} }] }) // post-unlink tracker read
      .mockResolvedValueOnce({ rows: [trackerRow] }) // notifyTrackerItemUpdated
      .mockResolvedValueOnce({ rows: [] }); // post-unlink session read for notification

    const result = await handleTrackerUnlinkSession(
      { trackerId: 'NIM-1', sessionId: 'session_missing' },
      undefined,
      '/tmp/ws',
    );

    expect(result.isError).toBe(false);
    const sqls = mockQuery.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('SELECT 1 FROM ai_sessions'))).toBe(false);
    expect(sqls.some((s) => s.includes('UPDATE ai_sessions'))).toBe(false);

    const payload = JSON.parse(result.content[0].text!);
    expect(payload.structured.sessionId).toBe('session_missing');
    expect(payload.structured.linkedCount).toBe(0);
    expect(payload.structured.removed).toBe(true);
  });
});
