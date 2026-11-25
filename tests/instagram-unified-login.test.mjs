import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authenticateInstagramUnified,
  getInstagramUnifiedAccount,
  instagramUnifiedAuthUrl,
  isInstagramUnifiedToken,
  listInstagramUnifiedAccounts,
} from '../libraries/nestjs-libraries/src/integrations/social/instagram.unified-login.ts';

const config = { appId: '12', appSecret: 'test-secret', configId: '34' };
const credential = 'test-token___test-token___unified';
const redirect = 'https://example.test/integrations/social/instagram';

test('Unified OAuth selects a configuration and preserves the redirect and state', () => {
  const url = new URL(instagramUnifiedAuthUrl(config, redirect, 'test-state'));
  assert.equal(url.origin, 'https://www.facebook.com');
  assert.equal(url.pathname, '/v27.0/dialog/oauth');
  assert.equal(url.searchParams.get('client_id'), config.appId);
  assert.equal(url.searchParams.get('config_id'), config.configId);
  assert.equal(url.searchParams.get('redirect_uri'), redirect);
  assert.equal(url.searchParams.get('state'), 'test-state');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('prompt'), 'login');
  assert.ok(!url.searchParams.has('scope'));
  assert.ok(!url.searchParams.has('client_secret'));
});

test('the token exchange binds the credential to the app and its client portfolio', async (t) => {
  const authUrl = new URL(instagramUnifiedAuthUrl(config, redirect, 'test-state'));
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url.origin, 'https://graph.facebook.com');
    assert.equal(options.redirect, 'error');
    switch (url.pathname) {
      case '/v27.0/oauth/access_token':
        assert.equal(url.searchParams.get('code'), 'code+&special');
        assert.equal(
          url.searchParams.get('redirect_uri'),
          authUrl.searchParams.get('redirect_uri')
        );
        return Response.json({ access_token: 'test-token' });
      case '/v27.0/debug_token':
        assert.equal(options.headers.Authorization, 'Bearer 12|test-secret');
        return Response.json({
          data: {
            app_id: 12,
            is_valid: true,
            scopes: ['instagram_basic'],
            expires_at: 0,
          },
        });
      case '/v27.0/me':
        assert.equal(options.headers.Authorization, 'Bearer test-token');
        assert.equal(url.searchParams.get('fields'), 'client_business_id');
        return Response.json({ client_business_id: '56' });
      default:
        assert.fail('Unexpected Graph request');
    }
  });
  const result = await authenticateInstagramUnified(
    config,
    'code+&special',
    redirect
  );
  assert.equal(fetch.mock.callCount(), 3);
  assert.equal(result.id, 'instagram-unified-56');
  assert.equal(result.accessToken, credential);
  assert.ok(isInstagramUnifiedToken(result.accessToken));
  assert.equal(isInstagramUnifiedToken('page-token___user-token'), false);
  assert.equal(result.expiresIn, undefined);
  assert.deepEqual(result.scopes, ['instagram_basic']);
});

test('Graph failures report the OAuth stage without exposing the response message', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(
      { error: { code: 100, error_subcode: 36008, message: 'test-secret' } },
      { status: 400 }
    )
  );
  await assert.rejects(
    authenticateInstagramUnified(config, 'test-code', redirect),
    {
      message:
        'Instagram Graph oauth/access_token failed (HTTP 400, code 100, subcode 36008)',
    }
  );
});

test('account discovery uses only the Graph cursor and enforces the offered selection', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url.origin, 'https://graph.facebook.com');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    if (url.pathname === '/v27.0/99') {
      return Response.json({
        id: '99',
        name: 'Account',
        username: 'test-profile',
      });
    }
    assert.equal(url.pathname, '/v27.0/me/assigned_instagram_accounts');
    if (!url.searchParams.has('after')) {
      return Response.json({
        data: [],
        paging: {
          next: 'https://other.example.test/',
          cursors: { after: 'next+cursor' },
        },
      });
    }
    assert.equal(url.searchParams.get('after'), 'next+cursor');
    return Response.json({ data: [{ id: '99', username: 'test-profile' }] });
  });
  assert.deepEqual(await listInstagramUnifiedAccounts(credential), [
    {
      id: '99',
      pageId: '99',
      name: 'test-profile',
      picture: { data: { url: '' } },
    },
  ]);
  assert.equal(
    await getInstagramUnifiedAccount(credential, {
      id: '99',
      pageId: '99',
    }).then((account) => account.username),
    'test-profile'
  );
  await assert.rejects(
    getInstagramUnifiedAccount(credential, {
      id: '100',
      pageId: '100',
    }),
    /outside the authorized portfolio/
  );
  assert.equal(
    fetch.mock.calls.some(
      (call) => call.arguments[0].pathname === '/v27.0/100'
    ),
    false
  );
});
