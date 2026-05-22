import type { UserInput } from "../types.js";
import { injectMentionedSkills, type SkillInjectionResult } from "./injection.js";
import { loadSkills } from "./loader.js";
import type { SkillLoadOutcome, SkillRuntimeConfig } from "./model.js";

export class SkillManager {
  private lastOutcome: SkillLoadOutcome = { skills: [], errors: [] };

  constructor(
    private readonly cwd: string,
    private readonly config: SkillRuntimeConfig | undefined
  ) {}

  load(): SkillLoadOutcome {
    this.lastOutcome = loadSkills(this.cwd, this.config);
    return this.lastOutcome;
  }

  inject(input: UserInput | undefined): SkillInjectionResult {
    return injectMentionedSkills(input, this.lastOutcome.skills);
  }
}
