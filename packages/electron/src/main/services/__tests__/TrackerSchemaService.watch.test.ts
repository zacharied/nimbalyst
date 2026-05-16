import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: vi.fn(),
}));

interface TrackerSchemaServiceModule {
  initTrackerSchemaService: (workspacePath?: string | null) => void;
  updateTrackerSchemaWorkspace: (workspacePath: string | null) => void;
  getTrackerSchema: (type: string) => { displayName: string } | undefined;
}

function buildYaml(displayName: string): string {
  return `packageVersion: 1.0.0
packageId: developer

type: runtime-watch
displayName: ${displayName}
displayNamePlural: Runtime Watches
icon: science
color: "#0f766e"

modes:
  inline: false
  fullDocument: false

sync:
  mode: local
  scope: project

idPrefix: rwt
idFormat: ulid

fields:
  - name: title
    type: string
    required: true
    displayInline: true

  - name: status
    type: select
    default: backlog
    options:
      - value: backlog
        label: Backlog
      - value: done
        label: Done

roles:
  title: title
  workflowStatus: status
`;
}

async function waitFor(assertion: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!assertion()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Condition not met within ${timeoutMs}ms`);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

describe('TrackerSchemaService watcher', () => {
  let workspacePath: string;
  let trackersDir: string;
  let service: TrackerSchemaServiceModule;

  beforeAll(async () => {
    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'tracker-schema-watch-'));
    trackersDir = path.join(workspacePath, '.nimbalyst', 'trackers');
    await fs.mkdir(trackersDir, { recursive: true });
    service = await import('../TrackerSchemaService');
    service.initTrackerSchemaService(workspacePath);
  });

  afterAll(async () => {
    service.updateTrackerSchemaWorkspace(null);
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  it('hot-loads added, edited, and deleted workspace schemas', async () => {
    const filePath = path.join(trackersDir, 'runtime-watch.yaml');

    await fs.writeFile(filePath, buildYaml('Runtime Watch Added'), 'utf-8');
    await waitFor(() => service.getTrackerSchema('runtime-watch')?.displayName === 'Runtime Watch Added');

    await fs.writeFile(filePath, buildYaml('Runtime Watch Updated'), 'utf-8');
    await waitFor(() => service.getTrackerSchema('runtime-watch')?.displayName === 'Runtime Watch Updated');

    await fs.unlink(filePath);
    await waitFor(() => service.getTrackerSchema('runtime-watch') == null);
  });
});
