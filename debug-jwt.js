// Debug JWT Token
const jwt = "eyJraWQiOiIrUmRQVmJWNFBQcHFTT1cwak1BWkZ1elA4dXhGTUpnaWtvaGUzQVk2OTNJPSIsImFsZyI6IlJTMjU2In0.eyJzdWIiOiI2MTZiNDUzMC1mMDUxLTcwZjEtOTI0ZC0xNjQ3NzUyNzhlZWUiLCJpc3MiOiJodHRwczpcL1wvY29nbml0by1pZHAudXMtZWFzdC0yLmFtYXpvbmF3cy5jb21cL3VzLWVhc3QtMl9QajVmYmVzbksiLCJ2ZXJzaW9uIjoyLCJjbGllbnRfaWQiOiI0dGN2dGU4NnRudGRhZG5kZGltaXB2M2ozMyIsIm9yaWdpbl9qdGkiOiJlZDRlZWYxNC1kZDNkLTQwNDUtODEyMi0yYmNmZTc2MmZiN2YiLCJldmVudF9pZCI6IjE3MDJjZDIxLTRmMmItNGRjOS1hODgzLTcwMzE0NDIzODM3YyIsInRva2VuX3VzZSI6ImFjY2VzcyIsInNjb3BlIjoib3BlbmlkIHByb2ZpbGUgZW1haWwiLCJhdXRoX3RpbWUiOjE3NTQ2OTEwMDEsImV4cCI6MTc1NDY5NDYwMSwiaWF0IjoxNzU0NjkxMDAxLCJqdGkiOiIwOTI1ODgwNS05ZDIyLTRhNTgtYjJhMi0wNGI2ZTUzZTE0ZTIiLCJ1c2VybmFtZSI6IjYxNmI0NTMwLWYwNTEtNzBmMS05MjRkLTE2NDc3NTI3OGVlZSJ9.SHCowiTkwFdkeRwhtiQOg5MgjMu3I4Oa8_Gcc0DZ6sJJbkphGrluRRL1BqFDJT-yuqTGY4z_NsnGkVaLHAuXWoEkHiQwKp_JUglcuvfVomgi61GudXomtHsxv_f4VHfuz003ryFrq2vXCJBgOH2yCWmAXUoS15CEX5EF7SmIIrL7p8S43tLhoHmbZPq4W7kWACoSRrBzqr7f-MBrSwQFkuNSbWyhX4DQr6upFPnmgzstTWd-ZDAxidPtDCFQWGREAyiOxEipq4oSQ98T3qoPoDTwijWkyHNVtXiuF_090b4wLcIzw42VQ7ZA87CtTaEj-EO9rLsA2qcpGAMOZu8Q9Q";

function decodeJWT(token) {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) {
            throw new Error('Invalid JWT format');
        }
        
        const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
        
        return { header, payload };
    } catch (error) {
        console.error('Error decoding JWT:', error);
        return null;
    }
}

const decoded = decodeJWT(jwt);
if (decoded) {
    console.log('JWT Header:', JSON.stringify(decoded.header, null, 2));
    console.log('JWT Payload:', JSON.stringify(decoded.payload, null, 2));
    
    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    const exp = decoded.payload.exp;
    const isExpired = exp < now;
    
    console.log('\n--- Token Analysis ---');
    console.log('Current time:', now);
    console.log('Token expires:', exp);
    console.log('Is expired:', isExpired);
    console.log('Token use:', decoded.payload.token_use);
    console.log('Client ID:', decoded.payload.client_id);
    console.log('Issuer:', decoded.payload.iss);
} else {
    console.log('Failed to decode JWT');
} 