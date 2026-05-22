export type SkillScope = "repo" | "user";

export interface SkillMetadata {
  name: string;
  description: string;
  path: string;
  scope: SkillScope;
}

export interface SkillLoadError {
  path: string;
  message: string;
}

export interface SkillLoadOutcome {
  skills: SkillMetadata[];
  errors: SkillLoadError[];
}

export interface SkillRuntimeConfig {
  enabled?: boolean | undefined;
  roots?: string[] | undefined;
  disabled?: string[] | undefined;
  maxPromptBytes?: number | undefined;
}

export interface SkillInjection {
  name: string;
  path: string;
  contents: string;
}
