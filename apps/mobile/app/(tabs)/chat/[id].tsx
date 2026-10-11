import { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from 'react-native';
import { useLocalSearchParams, Stack } from 'expo-router';
import { Image } from 'expo-image';
import { Send, Camera, Check, CheckCheck } from 'lucide-react-native';
import * as ImagePicker from 'expo-image-picker';
import { supabase } from '@/lib/supabase';
import { prepareImageForUpload, waitForValidatedSignedUrl } from '@/lib/storage-upload';
import { useAuth } from '@/lib/auth-context';
import type { Message } from '@kaza/shared';

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const [messages, setMessages] = useState<Message[]>([]);
  const [signedAttachments, setSignedAttachments] = useState<Record<string, string>>({});
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [otherName, setOtherName] = useState('');
  const flatListRef = useRef<FlatList>(null);

  const loadMessages = useCallback(async () => {
    if (!id) return;
    try {
      const { data: convData } = await supabase
        .from('conversations')
        .select('*, tenant:profiles!tenant_id(full_name), landlord:profiles!landlord_id(full_name)')
        .eq('id', id)
        .single();

      if (convData && user) {
        const isTenant = convData.tenant_id === user.id;
        setOtherName(
          isTenant
            ? (convData as any).landlord?.full_name ?? 'Bailleur'
            : (convData as any).tenant?.full_name ?? 'Locataire',
        );
      }

      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', id)
        .order('created_at', { ascending: true });
      if (error) throw error;
      setMessages((data ?? []) as unknown as Message[]);

      await supabase.rpc('mark_conversation_read', { p_conversation_id: id });
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [id, user]);

  useEffect(() => { loadMessages(); }, [loadMessages]);

  // Resolve attachment paths only after Storage allows access.
  useEffect(() => {
    let cancelled = false;
    const paths = Array.from(
      new Set(messages.flatMap((message) => message.attachments ?? [])),
    ).filter((path) => !signedAttachments[path]);

    if (paths.length === 0) return;

    void (async () => {
      const resolved: Record<string, string> = {};

      for (const path of paths) {
        for (let attempt = 0; attempt < 12; attempt += 1) {
          const { data, error } = await supabase.storage
            .from('chat-files')
            .createSignedUrl(path, 3600);

          if (!error && data?.signedUrl) {
            resolved[path] = data.signedUrl;
            break;
          }

          if (attempt < 11) {
            await new Promise<void>((resolve) => setTimeout(resolve, 500));
          }
        }
      }

      if (!cancelled && Object.keys(resolved).length > 0) {
        setSignedAttachments((previous) => ({ ...previous, ...resolved }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [messages, signedAttachments]);

  // Realtime subscription
  useEffect(() => {
    if (!id) return;
    const channel = supabase
      .channel(`messages:${id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${id}` },
        (payload) => {
          const msg = payload.new as unknown as Message;
          setMessages((prev) => [...prev, msg]);
          supabase.rpc('mark_conversation_read', { p_conversation_id: id });
        },
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [id]);

  const handleSend = async () => {
    if (!text.trim() || !id || !user) return;
    const body = text.trim();
    setText('');
    setSending(true);

    try {
      const { error } = await supabase.from('messages').insert({
        conversation_id: id,
        sender_id: user.id,
        body,
        kind: 'text',
      });
      if (error) throw error;
    } catch {
      setText(body);
    } finally {
      setSending(false);
    }
  };

  const handlePickImage = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.7,
    });
    if (result.canceled || !result.assets[0] || !id || !user) return;

    const asset = result.assets[0];
    let uploadedPath: string | null = null;
    let insertAttempted = false;
    try {
      // Format réel détecté sur les octets : jamais l'extension ni blob.type.
      const image = await prepareImageForUpload(asset.uri);
      const path = `${user.id}/${Date.now()}.${image.extension}`;

      const { error: uploadError } = await supabase.storage
        .from('chat-files')
        .upload(path, image.bytes, { contentType: image.mime, upsert: false });
      if (uploadError) throw uploadError;
      uploadedPath = path;

      const signedUrl = await waitForValidatedSignedUrl('chat-files', path);
      if (!signedUrl) {
        throw new Error(
          "Le fichier n'a pas pu être validé à temps. Réessayez dans quelques instants.",
        );
      }

      insertAttempted = true;
      const { error: messageError } = await supabase.from('messages').insert({
        conversation_id: id,
        sender_id: user.id,
        body: null,
        kind: 'image',
        attachments: [path],
      });

      if (messageError) throw messageError;
      setSignedAttachments((previous) => ({ ...previous, [path]: signedUrl }));
    } catch (error) {
      // Do not delete if the database insert may have succeeded.
      if (uploadedPath && !insertAttempted) {
        try {
          const { error: cleanupError } = await supabase.storage
            .from('chat-files')
            .remove([uploadedPath]);
          if (cleanupError) console.error('[KAZA chat] cleanup failed', cleanupError);
        } catch (cleanupError) {
          console.error('[KAZA chat] cleanup threw', cleanupError);
        }
      }

      console.error('[KAZA chat] image send failed', error);
      Alert.alert(
        'Envoi de la photo impossible',
        error instanceof Error ? error.message : 'Une erreur inattendue est survenue.',
      );
    }
  };

  const isMe = (msg: Message) => msg.sender_id === user?.id;

  if (loading) {
    return (
      <View className="flex-1 bg-white items-center justify-center">
        <ActivityIndicator size="large" color="#0E4728" />
      </View>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: otherName || 'Chat' }} />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1 bg-slate-50"
        keyboardVerticalOffset={90}
      >
        <FlatList
          ref={flatListRef}
          data={messages}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: 12, gap: 6 }}
          onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: false })}
          renderItem={({ item }) => (
            <View className={`max-w-[80%] ${isMe(item) ? 'self-end' : 'self-start'}`}>
              <View
                className={`px-3 py-2 rounded-2xl ${
                  isMe(item) ? 'bg-kaza-vert rounded-br-sm' : 'bg-white border border-slate-200 rounded-bl-sm'
                }`}
              >
                {(item.attachments ?? []).map((path: string) => {
                  const url = signedAttachments[path];
                  return url ? (
                    <Image
                      key={path}
                      source={{ uri: url }}
                      contentFit="cover"
                      style={{ width: 220, height: 180, borderRadius: 12, marginBottom: 4 }}
                      accessibilityLabel="Photo jointe au message"
                    />
                  ) : (
                    <Text
                      key={'pending-' + path}
                      className={isMe(item) ? 'text-xs text-white' : 'text-xs text-slate-500'}
                    >
                      Photo en attente de validation ou indisponible.
                    </Text>
                  );
                })}
                {item.kind === 'image' &&
                  (item.attachments ?? []).length === 0 &&
                  item.body &&
                  /^https?:\/\//i.test(item.body) ? (
                    <Image
                      source={{ uri: item.body }}
                      contentFit="cover"
                      style={{ width: 220, height: 180, borderRadius: 12 }}
                      accessibilityLabel="Ancienne photo jointe au message"
                    />
                  ) : item.body ? (
                    <Text className={`text-sm ${isMe(item) ? 'text-white' : 'text-slate-900'}`}>
                      {item.body}
                    </Text>
                  ) : null}
              </View>
              <View className={`flex-row items-center mt-0.5 gap-1 ${isMe(item) ? 'self-end' : 'self-start'}`}>
                <Text className="text-[10px] text-slate-400">
                  {new Date(item.created_at).toLocaleTimeString('fr-BJ', { hour: '2-digit', minute: '2-digit' })}
                </Text>
                {isMe(item) && (
                  item.read_at ? (
                    <CheckCheck size={12} color="#10B981" />
                  ) : (
                    <Check size={12} color="#94A3B8" />
                  )
                )}
              </View>
            </View>
          )}
        />

        {/* Input */}
        <View className="flex-row items-center bg-white border-t border-slate-200 px-3 py-2 gap-2">
          <TouchableOpacity onPress={handlePickImage} className="p-2">
            <Camera size={22} color="#64748B" />
          </TouchableOpacity>
          <TextInput
            className="flex-1 bg-slate-100 rounded-2xl px-4 py-2 text-sm text-slate-900"
            placeholder="Message..."
            placeholderTextColor="#94A3B8"
            value={text}
            onChangeText={setText}
            multiline
            maxLength={2000}
          />
          <TouchableOpacity
            onPress={handleSend}
            disabled={!text.trim() || sending}
            className={`w-10 h-10 rounded-full items-center justify-center ${
              text.trim() ? 'bg-kaza-vert' : 'bg-slate-200'
            }`}
          >
            <Send size={18} color={text.trim() ? '#FFF' : '#94A3B8'} />
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </>
  );
}
