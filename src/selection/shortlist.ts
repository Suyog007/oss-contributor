import type { ProjectAnalysis } from '@/domain/schemas';

/**
 * Project selection.
 *
 * Discovery answers "is this repository worth looking at?" with a numeric
 * score. Selection answers "where should we spend investigation budget first?"
 * by combining that score with what the analysis found: maintainer health,
 * how many small contribution areas exist, how many evidenced weaknesses, and
 * whether the project's tests can be run. No model is involved; every point
 * is explained in `reasons`.
 */

export interface SelectableProject {
  fullName: string;
  state: string;
  discoveryScore: number;
  stars: number;
  language: string | null;
  analysis: ProjectAnalysis | null;
  openCandidates: number;
}

export interface ShortlistEntry {
  fullName: string;
  score: number;
  reasons: string[];
  project: SelectableProject;
}

const HEALTH_POINTS: Record<ProjectAnalysis['activity']['maintenanceHealth'], number> = {
  active: 20,
  steady: 14,
  slow: 4,
  stalled: -25,
};

const DIFFICULTY_POINTS: Record<'small' | 'medium' | 'large', number> = {
  small: 8,
  medium: 5,
  large: 1,
};

/** Returns null when the project must not be selected, with the reason in `reasons`. */
export function scoreForSelection(project: SelectableProject): ShortlistEntry | null {
  if (project.state !== 'ACTIVE' || !project.analysis) return null;
  const analysis = project.analysis;
  const reasons: string[] = [];
  let score = 0;

  const discovery = project.discoveryScore * 0.4;
  score += discovery;
  reasons.push(`discovery score ${project.discoveryScore.toFixed(0)} (+${discovery.toFixed(1)})`);

  const health = HEALTH_POINTS[analysis.activity.maintenanceHealth];
  score += health;
  reasons.push(`maintenance ${analysis.activity.maintenanceHealth} (${health >= 0 ? '+' : ''}${health})`);

  const areas = analysis.contributionAreas.reduce(
    (sum, area) => sum + DIFFICULTY_POINTS[area.difficulty],
    0,
  );
  const areaPoints = Math.min(24, areas);
  score += areaPoints;
  reasons.push(`${analysis.contributionAreas.length} contribution area(s) (+${areaPoints})`);

  const weaknessPoints = Math.min(
    10,
    analysis.weaknesses.reduce((sum, weakness) => sum + 2 * weakness.confidence, 0),
  );
  score += weaknessPoints;
  reasons.push(`${analysis.weaknesses.length} evidenced weakness(es) (+${weaknessPoints.toFixed(1)})`);

  if (analysis.testCommands.length > 0) {
    score += 8;
    reasons.push('tests can be run (+8)');
  } else {
    reasons.push('no known test command (+0): fixes cannot be verified');
  }

  if (project.openCandidates > 0) {
    const penalty = Math.min(15, project.openCandidates * 5);
    score -= penalty;
    reasons.push(`${project.openCandidates} candidate(s) already in flight (-${penalty})`);
  }

  return { fullName: project.fullName, score: Number(score.toFixed(2)), reasons, project };
}

export function rankProjects(projects: SelectableProject[], limit = 10): ShortlistEntry[] {
  return projects
    .map(scoreForSelection)
    .filter((entry): entry is ShortlistEntry => entry !== null)
    .sort((a, b) => b.score - a.score || a.fullName.localeCompare(b.fullName))
    .slice(0, limit);
}
