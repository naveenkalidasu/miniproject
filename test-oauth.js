require('dotenv').config();

console.log('🔍 Verifying Google OAuth Configuration...\n');

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

// Validate Client ID
if (clientId && clientId !== 'YOUR_CLIENT_ID_HERE.apps.googleusercontent.com') {
    console.log('✅ GOOGLE_CLIENT_ID:', clientId);
} else {
    console.log('❌ GOOGLE_CLIENT_ID is not set correctly');
}

// Validate Client Secret (hide most of it for security)
if (clientSecret && clientSecret !== 'YOUR_CLIENT_SECRET_HERE') {
    const masked = clientSecret.substring(0, 10) + '...' + clientSecret.substring(clientSecret.length - 4);
    console.log('✅ GOOGLE_CLIENT_SECRET:', masked);
} else {
    console.log('❌ GOOGLE_CLIENT_SECRET is not set correctly');
}

// Validate Callback URL
const callbackUrl = process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3000/auth/google/callback';
console.log('✅ GOOGLE_CALLBACK_URL:', callbackUrl);

console.log('\n📝 Make sure your email is added as a test user in Google Cloud Console!');
console.log('📍 Go to: APIs & Services → OAuth consent screen → Test users');

console.log('\n🚀 You can now start the server and test Google login!');