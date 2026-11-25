const graph = 'https://graph.facebook.com/v27.0/';
const tokenSuffix = '___unified';

export const instagramUnifiedScopes = [
  'instagram_basic',
  'instagram_content_publish',
  'instagram_manage_comments',
  'instagram_manage_insights',
];

export function instagramUnifiedConfig() {
  const configId = process.env.INSTAGRAM_UNIFIED_CONFIG_ID;
  if (!configId) {
    return undefined;
  }
  const appId = process.env.INSTAGRAM_UNIFIED_APP_ID;
  const appSecret = process.env.INSTAGRAM_UNIFIED_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error(
      'Instagram Unified Login requires a Meta app ID and secret'
    );
  }
  return { configId, appId, appSecret };
}

type UnifiedConfig = NonNullable<ReturnType<typeof instagramUnifiedConfig>>;

export function instagramUnifiedAuthUrl(
  config: UnifiedConfig,
  redirectUri: string,
  state: string
) {
  const parameters = new URLSearchParams({
    client_id: config.appId,
    config_id: config.configId,
    redirect_uri: redirectUri,
    state,
    response_type: 'code',
    override_default_response_type: 'true',
    prompt: 'login',
  });
  return 'https://www.facebook.com/v27.0/dialog/oauth?' + parameters;
}

export function isInstagramUnifiedToken(token: string) {
  return token.endsWith(tokenSuffix);
}

async function graphRequest<T>(
  endpoint: string,
  params: Record<string, string>,
  accessToken?: string
): Promise<T> {
  const url = new URL(endpoint, graph);
  url.search = new URLSearchParams(params).toString();
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: accessToken ? { Authorization: 'Bearer ' + accessToken } : {},
  });
  if (!response.ok) {
    throw new Error('Instagram rejected the Graph API request');
  }
  return response.json() as Promise<T>;
}

export async function authenticateInstagramUnified(
  config: UnifiedConfig,
  code: string
) {
  const { access_token: token } = await graphRequest<{ access_token?: string }>(
    'oauth/access_token',
    { client_id: config.appId, client_secret: config.appSecret, code }
  );
  if (!token) {
    throw new Error('Instagram did not issue an access token');
  }

  const { data } = await graphRequest<{
    data?: {
      app_id?: string;
      is_valid?: boolean;
      scopes?: string[];
      expires_at?: number;
    };
  }>(
    'debug_token',
    { input_token: token },
    config.appId + '|' + config.appSecret
  );

  if (!data?.is_valid || data.app_id !== config.appId) {
    throw new Error('Instagram did not confirm the app access token');
  }

  const { client_business_id: businessId } = await graphRequest<{
    client_business_id?: string;
  }>('me', { fields: 'client_business_id' }, token);
  if (!businessId || !/^\d+$/.test(businessId)) {
    throw new Error('Instagram did not return a business portfolio');
  }

  const expiresIn = data.expires_at
    ? data.expires_at - Math.floor(Date.now() / 1000)
    : undefined;
  if (expiresIn !== undefined && expiresIn <= 0) {
    throw new Error('Instagram issued an expired access token');
  }

  // Keep the two token positions used by the existing posting and analytics paths.
  // The suffix distinguishes this credential from already connected Facebook pages.
  return {
    id: 'instagram-unified-' + businessId,
    name: 'Instagram',
    username: '',
    accessToken: token + '___' + token + tokenSuffix,
    scopes: data.scopes || [],
    expiresIn,
  };
}

type InstagramAccount = { id: string; username: string };

export async function listInstagramUnifiedAccounts(token: string) {
  const accessToken = token.split('___')[0];
  const accounts = new Map<string, InstagramAccount>();
  const cursors = new Set<string>();
  const query = { fields: 'id,username', limit: '100' };
  let after: string | undefined;

  do {
    const response = await graphRequest<{
      data: InstagramAccount[];
      paging?: { next?: string; cursors?: { after?: string } };
    }>(
      'me/assigned_instagram_accounts',
      after ? { ...query, after } : query,
      accessToken
    );

    for (const account of response.data) {
      if (/^\d+$/.test(account.id) && account.username) {
        accounts.set(account.id, account);
      }
    }

    after = response.paging?.next ? response.paging.cursors?.after : undefined;
    if (after && cursors.has(after)) {
      throw new Error('Instagram returned a repeated pagination cursor');
    }
    if (after) {
      cursors.add(after);
    }
  } while (after);

  return [...accounts.values()].map(({ id, username }) => ({
    id,
    pageId: id,
    name: username,
    picture: { data: { url: '' } },
  }));
}

export async function getInstagramUnifiedAccount(
  token: string,
  { id, pageId }: { id: string; pageId: string }
) {
  const accounts = await listInstagramUnifiedAccounts(token);
  if (id !== pageId || !accounts.some((account) => account.id === id)) {
    throw new Error('Instagram account is outside the authorized portfolio');
  }

  const account = await graphRequest<{
    id: string;
    name?: string;
    profile_picture_url?: string;
    username: string;
  }>(
    id,
    { fields: 'id,name,profile_picture_url,username' },
    token.split('___')[0]
  );
  if (account.id !== id || !account.username) {
    throw new Error('Instagram did not confirm the selected account');
  }
  return {
    id: account.id,
    name: account.name || account.username,
    picture: account.profile_picture_url || '',
    username: account.username,
    access_token: token,
  };
}
