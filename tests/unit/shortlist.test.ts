import { describe, expect, it } from 'vitest';
import { rankProjects, scoreForSelection, type SelectableProject } from '@/selection/shortlist';
import type { ProjectAnalysis } from '@/domain/schemas';

function analysis(overrides: Partial<ProjectAnalysis> = {}): ProjectAnalysis {
  return {
    purpose: '',
    architecture: '',
    components: [],
    stack: [],
    testingStrategy: '',
    testCommands: ['npm test'],
    conventions: { commitStyle: '', styleNotes: [] },
    activity: { recentFocus: '', cadence: '', maintenanceHealth: 'active' },
    weaknesses: [],
    contributionAreas: [{ area: 'parser', why: '', difficulty: 'small', evidence: [] }],
    runInstructions: '',
    uncertainties: [],
    ...overrides,
  };
}

function project(overrides: Partial<SelectableProject> = {}): SelectableProject {
  return {
    fullName: 'a/b',
    state: 'ACTIVE',
    discoveryScore: 60,
    stars: 500,
    language: 'TypeScript',
    analysis: analysis(),
    openCandidates: 0,
    ...overrides,
  };
}

describe('scoreForSelection', () => {
  it('skips projects that are unanalyzed or not active', () => {
    expect(scoreForSelection(project({ analysis: null }))).toBeNull();
    expect(scoreForSelection(project({ state: 'BLOCKED' }))).toBeNull();
  });

  it('prefers healthy projects over stalled ones', () => {
    const healthy = scoreForSelection(project())!;
    const stalled = scoreForSelection(
      project({ analysis: analysis({ activity: { recentFocus: '', cadence: '', maintenanceHealth: 'stalled' } }) }),
    )!;
    expect(healthy.score).toBeGreaterThan(stalled.score);
  });

  it('penalizes projects with no runnable tests and with work already in flight', () => {
    const base = scoreForSelection(project())!.score;
    expect(scoreForSelection(project({ analysis: analysis({ testCommands: [] }) }))!.score).toBeLessThan(base);
    expect(scoreForSelection(project({ openCandidates: 2 }))!.score).toBeLessThan(base);
  });
});

describe('rankProjects', () => {
  it('sorts by score, drops ineligible projects and honors the limit', () => {
    const ranked = rankProjects(
      [
        project({ fullName: 'low/one', discoveryScore: 10 }),
        project({ fullName: 'high/one', discoveryScore: 90 }),
        project({ fullName: 'none/one', analysis: null }),
      ],
      2,
    );
    expect(ranked.map((entry) => entry.fullName)).toEqual(['high/one', 'low/one']);
  });
});
