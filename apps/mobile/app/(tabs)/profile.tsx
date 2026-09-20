import { useEffect, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Alert, TextInput, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import {
  Settings,
  History,
  Bookmark,
  HelpCircle,
  ChevronRight,
  CheckCircle,
  CreditCard,
  Bell,
  Lock,
  Pencil,
  MapPin,
  AlertTriangle,
  Smartphone,
} from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@/lib/auth-context';
import type { LandlordPayout, Profile } from '@kaza/shared';
import { supabase } from '@/lib/supabase';

const MOMO_OPTIONS = [
  { value: 'mtn', label: 'MTN MoMo' },
  { value: 'moov', label: 'Moov Money' },
  { value: 'celtiis', label: 'Celtiis Cash' },
] as const;

const BENIN_PHONE_RE = /^\+229\d{10}$/;

function missingLandlordFields(user: Profile | null): string[] {
  if (!user || user.role !== 'bailleur') return [];
  const missing: string[] = [];
  if ((user.full_name ?? '').trim().length < 2) missing.push('Nom complet');
  if (!user.phone || !BENIN_PHONE_RE.test(user.phone.replace(/\s+/g, ''))) missing.push('Téléphone');
  if (!(user.email ?? '').trim()) missing.push('Email');
  if (!(user.business_name ?? '').trim()) missing.push('Nom ou raison sociale');
  if (!user.momo_provider) missing.push('Opérateur Mobile Money');
  if (!user.momo_number || !BENIN_PHONE_RE.test(user.momo_number.replace(/\s+/g, ''))) {
    missing.push('Numéro Mobile Money');
  }
  return missing;
}

export default function ProfileScreen() {
  const { user, role, isPremium, signOut, refresh } = useAuth();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [businessName, setBusinessName] = useState('');
  const [momoProvider, setMomoProvider] = useState('');
  const [momoNumber, setMomoNumber] = useState('');
  const [taxId, setTaxId] = useState('');
  const [payouts, setPayouts] = useState<LandlordPayout[]>([]);

  const missing = useMemo(() => missingLandlordFields(user), [user]);
  const complete = role === 'bailleur' && user?.onboarding_completed === true;

  useEffect(() => {
    if (role !== 'bailleur') return;
    let active = true;
    void supabase
      .from('landlord_payouts')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(5)
      .then(({ data }) => {
        if (active) setPayouts((data ?? []) as LandlordPayout[]);
      });
    return () => { active = false; };
  }, [role, user?.id]);

  const startEdit = () => {
    if (!user) return;
    setBusinessName(user.business_name ?? '');
    setMomoProvider(user.momo_provider ?? '');
    setMomoNumber(user.momo_number ?? '');
    setTaxId(user.tax_id ?? '');
    setEditing(true);
  };

  const saveLandlordProfile = async () => {
    if (!user) return;
    const cleanMomo = momoNumber.replace(/\s+/g, '');
    if (cleanMomo && !BENIN_PHONE_RE.test(cleanMomo)) {
      Alert.alert('Numéro invalide', 'Utilisez le format béninois +229 suivi de 10 chiffres.');
      return;
    }
    if (cleanMomo && !momoProvider) {
      Alert.alert('Opérateur requis', 'Choisissez MTN, Moov ou Celtiis pour ce numéro.');
      return;
    }

    setSaving(true);
    try {
      const { error } = await supabase
        .from('profiles')
        .update({
          business_name: businessName.trim() || null,
          tax_id: taxId.trim() || null,
          momo_provider: momoProvider || null,
          momo_number: cleanMomo || null,
        })
        .eq('id', user.id);
      if (error) throw error;
      await refresh();
      setEditing(false);
      Alert.alert(
        'Profil enregistré',
        missing.length === 0 ? 'Votre profil propriétaire est complet.' : 'Les informations ont bien été enregistrées.',
      );
    } catch (error) {
      Alert.alert('Mise à jour impossible', error instanceof Error ? error.message : 'Réessayez.');
    } finally {
      setSaving(false);
    }
  };

  const handleSignOut = () => {
    Alert.alert('Déconnexion', 'Voulez-vous vraiment vous déconnecter ?', [
      { text: 'Annuler', style: 'cancel' },
      { text: 'Déconnexion', style: 'destructive', onPress: signOut },
    ]);
  };

  if (!user) return null;

  const initials = (user.full_name ?? 'U').charAt(0).toUpperCase();
  const isBailleur = role === 'bailleur';

  if (isBailleur) {
    return (
      <SafeAreaView className="flex-1 bg-white" edges={['top']}>
        <ScrollView className="flex-1" contentContainerStyle={{ padding: 20 }}>
          <View className="flex-row items-center mb-6">
            <View className="w-8 h-8 bg-kaza-vert rounded-lg items-center justify-center mr-2">
              <Text className="text-white text-sm font-bold">K</Text>
            </View>
            <Text className="text-lg font-bold text-kaza-vert">KAZA</Text>
          </View>

          <View className="items-center mb-6">
            <View className="w-20 h-20 bg-slate-200 rounded-full items-center justify-center mb-3">
              <Text className="text-2xl font-bold text-slate-500">{initials}</Text>
            </View>
            <Text className="text-xl font-bold text-slate-900">{user.full_name}</Text>
            {user.is_verified_landlord && (
              <View className="flex-row items-center mt-1">
                <CheckCircle size={14} color="#10B981" />
                <Text className="text-xs text-kaza-mint font-medium ml-1">Propriétaire Vérifié</Text>
              </View>
            )}
            <View className="flex-row items-center mt-0.5">
              <MapPin size={12} color="#94A3B8" />
              <Text className="text-xs text-slate-500 ml-1">Cotonou, Bénin</Text>
            </View>
            <TouchableOpacity className="mt-2" onPress={startEdit}>
              <View className="flex-row items-center">
                <Pencil size={12} color="#0E4728" />
                <Text className="text-xs text-kaza-vert font-medium ml-1">
                  {editing ? 'Modification en cours' : 'Modifier le profil'}
                </Text>
              </View>
            </TouchableOpacity>
          </View>

          <View className={`rounded-2xl p-4 mb-6 border ${complete ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'}`}>
            <View className="flex-row items-start">
              {complete ? (
                <CheckCircle size={20} color="#10B981" />
              ) : (
                <AlertTriangle size={20} color="#D97706" />
              )}
              <View className="ml-3 flex-1">
                <Text className="text-sm font-bold text-slate-900">
                  {complete ? 'Profil propriétaire complet' : 'Profil propriétaire incomplet'}
                </Text>
                <Text className="text-xs text-slate-600 mt-1">
                  {complete
                    ? 'Toutes les informations essentielles sont renseignées.'
                    : `Manquant : ${missing.join(' · ')}`}
                </Text>
              </View>
            </View>
          </View>

          {editing ? (
            <View className="mb-6">
              <Text className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">
                Compléter mon profil
              </Text>
              <View className="bg-white rounded-2xl border border-slate-100 p-4">
                <FieldLabel label="Nom ou raison sociale" />
                <TextInput
                  value={businessName}
                  onChangeText={setBusinessName}
                  placeholder="Ex. SARL Immo Bénin"
                  className="border border-slate-200 rounded-xl px-3 py-3 text-sm text-slate-900 mb-4"
                />

                <FieldLabel label="IFU (facultatif)" />
                <TextInput
                  value={taxId}
                  onChangeText={setTaxId}
                  placeholder="Identifiant Fiscal Unique"
                  className="border border-slate-200 rounded-xl px-3 py-3 text-sm text-slate-900 mb-4"
                />

                <FieldLabel label="Opérateur Mobile Money" />
                <View className="flex-row gap-2 mb-4">
                  {MOMO_OPTIONS.map((option) => {
                    const selected = momoProvider === option.value;
                    return (
                      <TouchableOpacity
                        key={option.value}
                        onPress={() => setMomoProvider(option.value)}
                        className={`flex-1 rounded-xl px-2 py-3 border ${selected ? 'bg-kaza-vert border-kaza-vert' : 'bg-white border-slate-200'}`}
                      >
                        <Text className={`text-center text-xs font-semibold ${selected ? 'text-white' : 'text-slate-600'}`}>
                          {option.label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                <FieldLabel label="Numéro Mobile Money" />
                <View className="flex-row items-center border border-slate-200 rounded-xl px-3 mb-5">
                  <Smartphone size={18} color="#64748B" />
                  <TextInput
                    value={momoNumber}
                    onChangeText={setMomoNumber}
                    placeholder="+229 01 00 00 00 00"
                    keyboardType="phone-pad"
                    className="flex-1 px-3 py-3 text-sm text-slate-900"
                  />
                </View>

                <View className="flex-row gap-3">
                  <TouchableOpacity
                    onPress={() => setEditing(false)}
                    className="flex-1 rounded-xl bg-slate-100 py-3"
                    disabled={saving}
                  >
                    <Text className="text-center font-semibold text-slate-600">Annuler</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={saveLandlordProfile}
                    className="flex-1 rounded-xl bg-kaza-vert py-3"
                    disabled={saving}
                  >
                    {saving ? (
                      <ActivityIndicator color="#FFFFFF" />
                    ) : (
                      <Text className="text-center font-semibold text-white">Enregistrer</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          ) : (
            <>
              <Text className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">
                Informations personnelles
              </Text>
              <View className="bg-slate-50 rounded-2xl p-4 mb-6">
                <InfoRow label="Nom complet" value={user.full_name ?? '-'} />
                <InfoRow label="Téléphone principal" value={user.phone ?? '-'} />
                <InfoRow label="Adresse Email" value={user.email ?? '-'} />
                <InfoRow label="Nom / raison sociale" value={user.business_name ?? 'À compléter'} />
                <InfoRow label="Mobile Money" value={user.momo_number ?? 'À compléter'} />
                <InfoRow label="Opérateur" value={user.momo_provider ?? 'À compléter'} />
              </View>
            </>
          )}

          <Text className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">
            Derniers reversements
          </Text>
          <View className="bg-white rounded-2xl border border-slate-100 mb-6 p-4">
            {payouts.length === 0 ? (
              <Text className="text-sm text-slate-500">Aucun reversement pour le moment.</Text>
            ) : (
              payouts.map((payout) => {
                const label =
                  payout.status === 'sent' ? 'Envoyé'
                  : payout.status === 'processing' ? 'En cours'
                  : payout.status === 'waiting_configuration' ? 'Configuration requise'
                  : payout.status === 'manual_review' ? 'À traiter'
                  : payout.status === 'failed' ? 'Échoué'
                  : 'En attente';
                return (
                  <View key={payout.id} className="flex-row items-center justify-between py-3 border-b border-slate-100">
                    <View className="flex-1">
                      <Text className="text-sm font-semibold text-slate-900">
                        {new Intl.NumberFormat('fr-FR').format(payout.amount)} FCFA
                      </Text>
                      <Text className="text-xs text-slate-500 mt-0.5">
                        {new Date(payout.created_at).toLocaleDateString('fr-FR')}
                      </Text>
                    </View>
                    <Text className="text-xs font-semibold text-slate-600">{label}</Text>
                  </View>
                );
              })
            )}
          </View>

          <Text className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">
            Paramètres & Gestion
          </Text>
          <View className="bg-white rounded-2xl border border-slate-100 mb-6">
            <MenuItem icon={CreditCard} label="Gestion des abonnements & paiements" onPress={() => router.push('/(tabs)/abonnement')} />
            <MenuItem icon={Bell} label="Notifications de vues et messages" onPress={() => router.push('/notifications')} />
            <MenuItem icon={Lock} label="Changer de mot de passe" onPress={() => router.push('/settings')} />
            <MenuItem icon={HelpCircle} label="Aide & Support Propriétaire" onPress={() => router.push('/help')} last />
          </View>

          <TouchableOpacity onPress={handleSignOut} className="py-3">
            <Text className="text-base font-semibold text-kaza-red">Déconnexion</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-white" edges={['top']}>
      <ScrollView className="flex-1" contentContainerStyle={{ padding: 20 }}>
        <View className="flex-row items-center justify-between mb-6">
          <Text className="text-2xl font-bold text-slate-900">Profil</Text>
          <TouchableOpacity onPress={() => router.push('/settings')}>
            <Settings size={22} color="#64748B" />
          </TouchableOpacity>
        </View>

        <View className="flex-row items-center mb-4">
          <View className="w-16 h-16 bg-slate-200 rounded-full items-center justify-center">
            <Text className="text-xl font-bold text-slate-500">{initials}</Text>
          </View>
          <View className="ml-4 flex-1">
            <Text className="text-lg font-bold text-slate-900">{user.full_name}</Text>
            <Text className="text-sm text-slate-500">{user.phone ?? ''}</Text>
            <View className="self-start bg-kaza-vert/15 px-2.5 py-0.5 rounded-full mt-1">
              <Text className="text-xs font-semibold text-kaza-vert">Locataire</Text>
            </View>
          </View>
        </View>

        <View className="bg-kaza-vert/5 border border-kaza-vert/15 rounded-2xl p-4 flex-row items-center justify-between mb-6">
          <View className="flex-row items-center flex-1">
            <CheckCircle size={20} color="#0E4728" />
            <View className="ml-3">
              <Text className="text-sm font-bold text-slate-900">Pass Locataire : {isPremium ? 'Actif' : 'Inactif'}</Text>
              {isPremium && <Text className="text-xs text-slate-500">Expire dans 18 jours</Text>}
            </View>
          </View>
          <TouchableOpacity><Text className="text-sm font-semibold text-kaza-vert">Renouveler</Text></TouchableOpacity>
        </View>

        <View className="bg-white rounded-2xl border border-slate-100">
          <MenuItem icon={History} label="Historique des numéros débloqués" onPress={() => {}} />
          <MenuItem icon={Bookmark} label="Mes recherches sauvegardées" onPress={() => router.push('/alerts')} />
          <MenuItem icon={Settings} label="Paramètres du compte" onPress={() => router.push('/settings')} />
          <MenuItem icon={HelpCircle} label="Centre d'aide / FAQ" onPress={() => router.push('/help')} last />
        </View>

        <TouchableOpacity onPress={handleSignOut} className="mt-6 py-3">
          <Text className="text-base font-semibold text-kaza-red">Déconnexion</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

function FieldLabel({ label }: { label: string }) {
  return <Text className="text-xs font-semibold text-slate-500 mb-1">{label}</Text>;
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-center justify-between py-3 border-b border-slate-100">
      <Text className="text-sm text-slate-500">{label}</Text>
      <Text className="text-sm font-medium text-slate-900 max-w-[58%] text-right">{value}</Text>
    </View>
  );
}

function MenuItem({ icon: Icon, label, onPress, last }: { icon: any; label: string; onPress: () => void; last?: boolean }) {
  return (
    <TouchableOpacity onPress={onPress} className={`flex-row items-center px-4 py-3.5 ${last ? '' : 'border-b border-slate-100'}`}>
      <Icon size={20} color="#64748B" />
      <Text className="flex-1 text-sm text-slate-700 ml-3">{label}</Text>
      <ChevronRight size={18} color="#CBD5E1" />
    </TouchableOpacity>
  );
}
