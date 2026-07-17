using Orders.Application.Abstractions;
using Orders.Application.Identity;

namespace Orders.Api.Identity;

public sealed class CurrentCaller : ICurrentCaller
{
    private readonly IUserDirectory _users;
    private string? _internalId;
    private bool _resolved;

    public CurrentCaller(IUserDirectory users) => _users = users;

    public string? CognitoSub { get; private set; }

    public void SetSub(string sub) => CognitoSub = sub;

    public async Task<string> ResolveInternalUserIdAsync(CancellationToken ct)
    {
        if (_resolved) return _internalId!;
        var sub = CognitoSub ?? throw new InvalidOperationException("caller sub not set");
        _internalId = await _users.ResolveInternalUserIdAsync(sub, ct)
            ?? throw new UnknownUserException(sub);
        _resolved = true;
        return _internalId;
    }
}
