// njs: decode the Cognito JWT from Authorization and return its `sub`.
// No signature check — the API Gateway JWT authorizer already validated the
// token (ADR-0010); this only extracts the claim so nginx can forward it as
// the x-user-id header the users service reads.
function jwtSub(r) {
  var auth = r.headersIn['Authorization'] || '';
  var token = auth.replace(/^Bearer\s+/i, '');
  var parts = token.split('.');
  if (parts.length < 2) return '';
  try {
    var payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (payload.length % 4) payload += '=';
    var claims = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    return claims.sub || '';
  } catch (e) { return ''; }
}
export default { jwtSub };
