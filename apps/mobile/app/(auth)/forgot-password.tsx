import { useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { ArrowLeft, Lock, Phone, RefreshCw, Eye, EyeOff } from 'lucide-react-native';
import { supabase } from '@/lib/supabase';
import { isValidBeninPhoneNumber, normalizeBeninPhone } from '@/lib/phone';

type Step = 'phone' | 'code' | 'password';

export default function ForgotPasswordScreen() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState(['', '', '', '', '', '']);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const inputs = useRef<(TextInput | null)[]>([]);

  const handleSendCode = async () => {
    const normalizedPhone = normalizeBeninPhone(phone);
    if (!isValidBeninPhoneNumber(normalizedPhone)) {
      Alert.alert('Erreur', 'Saisissez un numéro béninois valide à 10 chiffres.');
      return;
    }

    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithOtp({
        phone: normalizedPhone,
        options: { shouldCreateUser: false },
      });
      if (error) {
        // Avoid revealing whether a phone number belongs to a KAZA account.
        Alert.alert('Vérification impossible', 'Nous ne pouvons pas lancer cette vérification pour ce numéro. Vérifiez le numéro puis réessayez.');
        return;
      }
      setPhone(normalizedPhone);
      setCode(['', '', '', '', '', '']);
      setStep('code');
    } catch {
      Alert.alert('Erreur', 'Impossible d’envoyer le code SMS.');
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async () => {
    const normalizedPhone = normalizeBeninPhone(phone);
    const pin = code.join('');
    if (!isValidBeninPhoneNumber(normalizedPhone)) {
      Alert.alert('Erreur', 'Numéro béninois invalide.');
      return;
    }
    if (pin.length !== 6) {
      Alert.alert('Erreur', 'Entrez le code à 6 chiffres.');
      return;
    }

    setLoading(true);
    try {
      const { error } = await supabase.auth.verifyOtp({
        phone: normalizedPhone,
        token: pin,
        type: 'sms',
      });
      if (error) {
        Alert.alert('Code invalide', 'Le code est incorrect ou expiré.');
        return;
      }
      setStep('password');
    } catch {
      Alert.alert('Erreur', 'Vérification échouée.');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdatePassword = async () => {
    if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
      Alert.alert('Erreur', 'Le mot de passe doit contenir au moins 8 caractères, avec des lettres et des chiffres.');
      return;
    }

    setLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;

      await supabase.auth.signOut();
      Alert.alert('Mot de passe mis à jour', 'Vous pouvez maintenant vous connecter avec votre nouveau mot de passe.', [
        { text: 'Se connecter', onPress: () => router.replace('/(auth)/login') },
      ]);
    } catch (err: any) {
      Alert.alert('Erreur', err.message ?? 'Impossible de mettre à jour le mot de passe.');
    } finally {
      setLoading(false);
    }
  };

  const handleCodeChange = (text: string, index: number) => {
    const digit = text.replace(/\D/g, '').slice(-1);
    const next = [...code];
    next[index] = digit;
    setCode(next);
    if (digit && index < 5) inputs.current[index + 1]?.focus();
  };

  const handleKeyPress = (key: string, index: number) => {
    if (key === 'Backspace' && !code[index] && index > 0) {
      inputs.current[index - 1]?.focus();
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      className="flex-1 bg-white"
    >
      <View className="flex-1 px-6 pt-16">
        <TouchableOpacity onPress={() => router.back()} className="mb-8">
          <ArrowLeft size={24} color="#0E4728" />
        </TouchableOpacity>

        <View className="items-center mb-6">
          <View className="w-16 h-16 bg-kaza-vert/10 rounded-full items-center justify-center">
            {step === 'password' ? (
              <Lock size={28} color="#0E4728" />
            ) : (
              <RefreshCw size={28} color="#0E4728" />
            )}
          </View>
        </View>

        {step === 'phone' ? (
          <>
            <Text className="text-2xl font-bold text-slate-900 text-center mb-2">
              Mot de passe oublié ?
            </Text>
            <Text className="text-sm text-slate-500 text-center mb-8 px-4">
              Entrez votre numéro béninois. Un code SMS vous permettra de vérifier votre identité.
            </Text>
            <Text className="text-sm font-medium text-slate-700 mb-1.5">Numéro de téléphone</Text>
            <View className="flex-row items-center border border-slate-200 rounded-xl px-3 h-12 mb-6">
              <Phone size={18} color="#64748B" />
              <Text className="text-sm text-slate-500 ml-2 mr-1">+229</Text>
              <TextInput
                className="flex-1 text-sm text-slate-900 ml-1"
                placeholder="01 23 45 67 89"
                placeholderTextColor="#94A3B8"
                keyboardType="phone-pad"
                value={phone}
                onChangeText={setPhone}
              />
            </View>
            <TouchableOpacity
              onPress={() => void handleSendCode()}
              disabled={loading}
              className="bg-kaza-vert h-12 rounded-xl items-center justify-center"
            >
              {loading ? <ActivityIndicator color="#FFF" /> : <Text className="text-white text-base font-semibold">Envoyer le code SMS</Text>}
            </TouchableOpacity>
          </>
        ) : step === 'code' ? (
          <>
            <Text className="text-2xl font-bold text-slate-900 text-center mb-2">
              Vérifier votre numéro
            </Text>
            <Text className="text-sm text-slate-500 text-center mb-6">
              Entrez le code à 6 chiffres envoyé au {phone}.
            </Text>
            <View className="flex-row justify-between mb-6 gap-2">
              {code.map((digit, index) => (
                <TextInput
                  key={index}
                  ref={(input) => { inputs.current[index] = input; }}
                  className="flex-1 h-14 bg-slate-50 border border-slate-200 rounded-xl text-center text-xl font-bold text-slate-900"
                  maxLength={1}
                  keyboardType="number-pad"
                  value={digit}
                  onChangeText={(text) => handleCodeChange(text, index)}
                  onKeyPress={({ nativeEvent }) => handleKeyPress(nativeEvent.key, index)}
                />
              ))}
            </View>
            <TouchableOpacity
              onPress={() => void handleVerify()}
              disabled={loading}
              className="bg-kaza-vert h-12 rounded-xl items-center justify-center"
            >
              {loading ? <ActivityIndicator color="#FFF" /> : <Text className="text-white text-base font-semibold">Vérifier le code</Text>}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => void handleSendCode()} disabled={loading} className="mt-4 items-center">
              <Text className="text-sm text-kaza-vert">Renvoyer le code</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            <Text className="text-2xl font-bold text-slate-900 text-center mb-2">
              Nouveau mot de passe
            </Text>
            <Text className="text-sm text-slate-500 text-center mb-8 px-4">
              Choisissez un nouveau mot de passe pour votre compte KAZA.
            </Text>
            <Text className="text-sm font-medium text-slate-700 mb-1.5">Mot de passe</Text>
            <View className="flex-row items-center border border-slate-200 rounded-xl px-3 h-12 mb-6">
              <Lock size={18} color="#64748B" />
              <TextInput
                className="flex-1 text-sm text-slate-900 ml-2"
                placeholder="8 caractères min, lettres + chiffres"
                placeholderTextColor="#94A3B8"
                secureTextEntry={!showPassword}
                value={password}
                onChangeText={setPassword}
                autoCapitalize="none"
              />
              <TouchableOpacity onPress={() => setShowPassword((value) => !value)}>
                {showPassword ? <Eye size={18} color="#64748B" /> : <EyeOff size={18} color="#64748B" />}
              </TouchableOpacity>
            </View>
            <TouchableOpacity
              onPress={() => void handleUpdatePassword()}
              disabled={loading}
              className="bg-kaza-vert h-12 rounded-xl items-center justify-center"
            >
              {loading ? <ActivityIndicator color="#FFF" /> : <Text className="text-white text-base font-semibold">Enregistrer le nouveau mot de passe</Text>}
            </TouchableOpacity>
          </>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}
