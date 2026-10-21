package com.kithwall.app;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.interfaces.ECPrivateKey;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPublicKeySpec;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * RFC 8291 Web Push message decryption ("aes128gcm", RFC 8188), the receiving side of
 * apps/web/src/lib/push/crypto.ts encryptPush(). Unit-tested on the server side against the RFC 8291
 * example; this is a line-by-line port of decryptPush() there.
 */
final class PushCrypto {
    private PushCrypto() {}

    static KeyPair newKeyPair() throws Exception {
        KeyPairGenerator g = KeyPairGenerator.getInstance("EC");
        g.initialize(new ECGenParameterSpec("secp256r1"));
        return g.generateKeyPair();
    }

    static ECPrivateKey privateFromPkcs8(byte[] der) throws Exception {
        return (ECPrivateKey) KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(der));
    }

    static ECPublicKey publicFromX509(byte[] der) throws Exception {
        return (ECPublicKey) KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(der));
    }

    private static byte[] fixed32(BigInteger v) {
        byte[] b = v.toByteArray();
        if (b.length == 32) return b;
        byte[] out = new byte[32];
        if (b.length > 32) System.arraycopy(b, b.length - 32, out, 0, 32);
        else System.arraycopy(b, 0, out, 32 - b.length, b.length);
        return out;
    }

    /** 65-byte uncompressed point 0x04 ‖ X ‖ Y. */
    static byte[] encodePoint(ECPublicKey pub) {
        ECPoint w = pub.getW();
        byte[] out = new byte[65];
        out[0] = 4;
        System.arraycopy(fixed32(w.getAffineX()), 0, out, 1, 32);
        System.arraycopy(fixed32(w.getAffineY()), 0, out, 33, 32);
        return out;
    }

    static ECPublicKey decodePoint(byte[] p, ECParameterSpec params) throws Exception {
        if (p.length != 65 || p[0] != 4) throw new IllegalArgumentException("bad point");
        BigInteger x = new BigInteger(1, Arrays.copyOfRange(p, 1, 33));
        BigInteger y = new BigInteger(1, Arrays.copyOfRange(p, 33, 65));
        return (ECPublicKey) KeyFactory.getInstance("EC").generatePublic(new ECPublicKeySpec(new ECPoint(x, y), params));
    }

    private static byte[] hmac(byte[] key, byte[]... parts) throws Exception {
        Mac m = Mac.getInstance("HmacSHA256");
        m.init(new SecretKeySpec(key, "HmacSHA256"));
        for (byte[] p : parts) m.update(p);
        return m.doFinal();
    }

    /** HKDF-SHA-256 (extract + one expand block), len ≤ 32. */
    private static byte[] hkdf(byte[] salt, byte[] ikm, byte[] info, int len) throws Exception {
        byte[] prk = hmac(salt, ikm);
        return Arrays.copyOf(hmac(prk, info, new byte[] { 1 }), len);
    }

    private static byte[] concat(byte[]... parts) {
        int n = 0;
        for (byte[] p : parts) n += p.length;
        byte[] out = new byte[n];
        int o = 0;
        for (byte[] p : parts) { System.arraycopy(p, 0, out, o, p.length); o += p.length; }
        return out;
    }

    static byte[] decrypt(ECPrivateKey priv, ECPublicKey pub, byte[] auth, byte[] msg) throws Exception {
        if (msg.length < 21 + 65 + 17) throw new IllegalArgumentException("short message");
        byte[] salt = Arrays.copyOfRange(msg, 0, 16);
        int rs = ((msg[16] & 0xff) << 24) | ((msg[17] & 0xff) << 16) | ((msg[18] & 0xff) << 8) | (msg[19] & 0xff);
        int idlen = msg[20] & 0xff;
        if (idlen != 65 || rs < 18) throw new IllegalArgumentException("bad header");
        byte[] asPublic = Arrays.copyOfRange(msg, 21, 21 + idlen);
        byte[] ct = Arrays.copyOfRange(msg, 21 + idlen, msg.length);
        if (ct.length > rs) throw new IllegalArgumentException("multiple records are not used");

        KeyAgreement ka = KeyAgreement.getInstance("ECDH");
        ka.init(priv);
        ka.doPhase(decodePoint(asPublic, pub.getParams()), true);
        byte[] secret = ka.generateSecret();

        byte[] uaPublic = encodePoint(pub);
        byte[] keyInfo = concat("WebPush: info\0".getBytes(StandardCharsets.US_ASCII), uaPublic, asPublic);
        byte[] ikm = hkdf(auth, secret, keyInfo, 32);
        byte[] cek = hkdf(salt, ikm, "Content-Encoding: aes128gcm\0".getBytes(StandardCharsets.US_ASCII), 16);
        byte[] nonce = hkdf(salt, ikm, "Content-Encoding: nonce\0".getBytes(StandardCharsets.US_ASCII), 12);

        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(cek, "AES"), new GCMParameterSpec(128, nonce));
        byte[] record = c.doFinal(ct);
        int end = record.length - 1;
        while (end >= 0 && record[end] == 0) end--;
        if (end < 0 || record[end] != 2) throw new IllegalArgumentException("bad padding");
        Arrays.fill(secret, (byte) 0);
        return Arrays.copyOf(record, end);
    }
}
