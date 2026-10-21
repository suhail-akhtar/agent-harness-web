// What the sign-in page offers, from the server's GET /auth/config.

export interface AuthConfig { oidc: boolean; only: boolean; login: string | null }

export interface SignInChoices {
  /** Where the "Sign in" button goes (single sign-on), if anywhere. */
  sso: string | null;
  /** The token form: shown, behind a link, or not offered. */
  token: 'shown' | 'link' | 'none';
  tokenLabel: string;
}

export function signInChoices(auth: AuthConfig | null): SignInChoices {
  // Until the server answers, offer nothing rather than the wrong thing.
  if (!auth) return { sso: null, token: 'none', tokenLabel: '' };
  if (!auth.oidc || !auth.login) return { sso: null, token: 'shown', tokenLabel: 'Enter the access token printed by the server (or set as HARNESS_TOKEN).' };
  // With single sign-on people use the provider; the token form stays for the operator (and, unless SSO-only, token accounts).
  return { sso: auth.login, token: 'link', tokenLabel: auth.only ? 'Operator token' : 'Use an access token' };
}
