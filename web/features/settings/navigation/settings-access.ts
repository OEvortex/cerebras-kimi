export interface SettingsAccess {
  /** False until the backend has resolved the runtime auth mode and account. */
  resolved: boolean;
  /** Admin-owned settings stay hidden on auth failures and for ordinary users. */
  hideAdminOnly: boolean;
  /** The self-service learner profile belongs only to learner accounts. */
  showLearnerOnly: boolean;
  /** Ordinary standard/custom accounts may act as authorized guardians. */
  showGuardianOnly: boolean;
}

/** Single-user deployment: every settings surface is visible. */
export const SETTINGS_ACCESS: SettingsAccess = {
  resolved: true,
  hideAdminOnly: false,
  showLearnerOnly: false,
  showGuardianOnly: false,
};
