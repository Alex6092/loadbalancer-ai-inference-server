<?php
// Extrait serveur PHP : conserver la clé hors du code et hors du navigateur.
function submit_ai_job(string $userId, array $messages, string $idempotencyKey): array {
    $ch = curl_init(rtrim(getenv('AI_BASE_URL'), '/') . '/v1/jobs');
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_TIMEOUT => 20,
        CURLOPT_HTTPHEADER => [
            'Content-Type: application/json',
            'Authorization: Bearer ' . getenv('AI_API_KEY'),
            'X-End-User-ID: ' . $userId,
            'Idempotency-Key: ' . $idempotencyKey,
        ],
        CURLOPT_POSTFIELDS => json_encode([
            'model' => getenv('AI_MODEL'), 'messages' => $messages,
            'max_tokens' => 1024, 'callbackURL' => getenv('AI_CALLBACK_URL'),
        ], JSON_THROW_ON_ERROR),
    ]);
    $response = curl_exec($ch);
    if ($response === false) throw new RuntimeException(curl_error($ch));
    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    $result = json_decode($response, true, 512, JSON_THROW_ON_ERROR);
    if ($status >= 400) throw new RuntimeException($result['error']['message'] ?? 'Erreur IA');
    return $result;
}

// Dans le contrôleur de callback : vérifier avant de décoder ou de traiter.
function verify_ai_callback(string $body, string $timestamp, string $signature): bool {
    if (!ctype_digit($timestamp) || abs(time() - (int)$timestamp) > 300) return false;
    $expected = 'sha256=' . hash_hmac('sha256', $timestamp . '.' . $body, getenv('AI_CALLBACK_SECRET'));
    return hash_equals($expected, $signature);
}
// Après vérification : décoder le corps, vérifier que son champ id signé est égal
// à X-Event-ID, puis enregistrer cet id dans une table UNIQUE et appliquer le
// résultat dans la même transaction ; répondre 2xx, y compris si déjà reçu.
