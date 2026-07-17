using Moq;
using Orders.Api.Identity;
using Orders.Application.Abstractions;
using Orders.Application.Identity;

namespace Orders.Tests.Identity;

public class CurrentCallerTests
{
    [Fact]
    public async Task Resolves_internal_id_once_and_caches()
    {
        var dir = new Mock<IUserDirectory>();
        dir.Setup(d => d.ResolveInternalUserIdAsync("sub-1", It.IsAny<CancellationToken>()))
           .ReturnsAsync("usr_1");
        var caller = new CurrentCaller(dir.Object);
        caller.SetSub("sub-1");

        var a = await caller.ResolveInternalUserIdAsync(default);
        var b = await caller.ResolveInternalUserIdAsync(default);

        Assert.Equal("usr_1", a);
        Assert.Equal("usr_1", b);
        dir.Verify(d => d.ResolveInternalUserIdAsync("sub-1", It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async Task Throws_UnknownUser_when_directory_returns_null()
    {
        var dir = new Mock<IUserDirectory>();
        dir.Setup(d => d.ResolveInternalUserIdAsync(It.IsAny<string>(), It.IsAny<CancellationToken>()))
           .ReturnsAsync((string?)null);
        var caller = new CurrentCaller(dir.Object);
        caller.SetSub("sub-x");
        await Assert.ThrowsAsync<UnknownUserException>(() => caller.ResolveInternalUserIdAsync(default));
    }
}
