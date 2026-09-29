import { describe, expect, test } from 'vitest';
import {
  createTestUser,
  deleteTestUser,
  supabaseAdmin,
} from '../helpers/supabase-test-client';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://localhost:54321';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_ANON_KEY) {
  throw new Error('Missing NEXT_PUBLIC_SUPABASE_ANON_KEY for phone auth integration tests');
}

const TEST_PHONE = '+2290190000000';
const TEST_OTP = '123456';
const UNKNOWN_PHONE = '+2290190000001';

function createAuthClient() {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

describe('Phone authentication', () => {
  test('activates the profile phone, confirms it, then signs in by SMS without creating duplicates', async () => {
    const { user: createdUser, email, password } = await createTestUser('locataire');

    try {
      const { error: profileError } = await supabaseAdmin
        .from('profiles')
        .update({ phone: TEST_PHONE })
        .eq('id', createdUser.id);
      expect(profileError).toBeNull();

      const authClient = createAuthClient();
      const { data: signInData, error: signInError } =
        await authClient.auth.signInWithPassword({ email, password });
      expect(signInError).toBeNull();
      expect(signInData.user?.id).toBe(createdUser.id);

      const { data: beforeActivation } = await supabaseAdmin.auth.admin.getUserById(createdUser.id);
      expect(beforeActivation.user?.phone).toBeNull();
      expect(beforeActivation.user?.phone_confirmed_at).toBeNull();

      const { error: updatePhoneError } = await authClient.auth.updateUser({ phone: TEST_PHONE });
      expect(updatePhoneError).toBeNull();

      const { data: pendingActivation } = await supabaseAdmin.auth.admin.getUserById(createdUser.id);
      expect(pendingActivation.user?.phone).toBeNull();
      expect(pendingActivation.user?.phone_confirmed_at).toBeNull();

      const { data: verifyData, error: verifyError } = await authClient.auth.verifyOtp({
        phone: TEST_PHONE,
        token: TEST_OTP,
        type: 'phone_change',
      });
      expect(verifyError).toBeNull();
      expect(verifyData.user?.id).toBe(createdUser.id);

      const { data: activated } = await supabaseAdmin.auth.admin.getUserById(createdUser.id);
      expect(activated.user?.phone).toBe(TEST_PHONE);
      expect(activated.user?.phone_confirmed_at).not.toBeNull();

      const { count: userCountBeforeSms } = await supabaseAdmin
        .from('profiles')
        .select('id', { count: 'exact', head: true });

      await authClient.auth.signOut();

      const { error: otpRequestError } = await authClient.auth.signInWithOtp({
        phone: TEST_PHONE,
        options: {
          shouldCreateUser: false,
        },
      });
      expect(otpRequestError).toBeNull();

      const { data: smsLogin, error: smsVerifyError } = await authClient.auth.verifyOtp({
        phone: TEST_PHONE,
        token: TEST_OTP,
        type: 'sms',
      });
      expect(smsVerifyError).toBeNull();
      expect(smsLogin.user?.id).toBe(createdUser.id);

      const { data: afterSmsUser } = await supabaseAdmin.auth.admin.getUserById(createdUser.id);
      expect(afterSmsUser.user?.phone).toBe(TEST_PHONE);

      const { count: userCountAfterSms } = await supabaseAdmin
        .from('profiles')
        .select('id', { count: 'exact', head: true });
      expect(userCountAfterSms).toBe(userCountBeforeSms);

      await authClient.auth.signOut();
    } finally {
      await deleteTestUser(createdUser.id);
    }
  });

  test('refuses unknown phone without creating a new account', async () => {
    const { user: createdUser } = await createTestUser('locataire');

    try {
      const { count: beforeCount } = await supabaseAdmin
        .from('profiles')
        .select('id', { count: 'exact', head: true });

      const authClient = createAuthClient();
      const { error } = await authClient.auth.signInWithOtp({
        phone: UNKNOWN_PHONE,
        options: {
          shouldCreateUser: false,
        },
      });

      expect(error).toBeNull();

      const { count: afterCount } = await supabaseAdmin
        .from('profiles')
        .select('id', { count: 'exact', head: true });
      expect(afterCount).toBe(beforeCount);

      const { data: unknownUsers } = await supabaseAdmin.auth.admin.listUsers();
      expect(
        unknownUsers.users.some((candidate) => candidate.phone === UNKNOWN_PHONE),
      ).toBe(false);
    } finally {
      await deleteTestUser(createdUser.id);
    }
  });
});
