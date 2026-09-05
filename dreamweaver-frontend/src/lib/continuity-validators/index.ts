export * from "./types";
export * from "./walk";
export { checkAxisLineBreak, checkScreenDirectionReversal } from "./axis";
export { checkThirtyDegreeRule } from "./thirty-degree";
export { checkEyelineMismatch } from "./eyeline";
export { checkVoiceCoverage } from "./voice-coverage";
export {
  checkVoiceGenderMismatch,
  inferPackGender,
  VOICE_GENDER_HINT,
} from "./voice-gender";

import type { ValidatorFn, ValidatorInput, ValidatorViolation } from "./types";
import { checkAxisLineBreak, checkScreenDirectionReversal } from "./axis";
import { checkThirtyDegreeRule } from "./thirty-degree";
import { checkEyelineMismatch } from "./eyeline";
import { checkVoiceCoverage } from "./voice-coverage";
import { checkVoiceGenderMismatch } from "./voice-gender";

export const DEFAULT_VALIDATORS: ValidatorFn[] = [
  checkAxisLineBreak,
  checkScreenDirectionReversal,
  checkThirtyDegreeRule,
  checkEyelineMismatch,
  checkVoiceCoverage,
  checkVoiceGenderMismatch,
];

export const runShotValidators = (
  input: ValidatorInput,
  validators: ValidatorFn[] = DEFAULT_VALIDATORS,
): ValidatorViolation[] => validators.flatMap((v) => v(input));
