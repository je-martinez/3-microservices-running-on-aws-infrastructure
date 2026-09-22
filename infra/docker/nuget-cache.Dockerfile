# Pre-warmed NuGet cache for the Orders build.
#
# CONTRACT: The restored packages live in an IMAGE LAYER, not in BuildKit's
# cache. `make clean` runs `builder prune -af`, which deletes BuildKit state but
# never a tagged image, so this survives a teardown and the next restore
# resolves offline. Rebuild it with `make warm-nuget` after changing a
# PackageReference; a new package is the only thing that reaches nuget.org.
#
# WARNING: Do NOT fold this into services/orders/Dockerfile as a cache mount. A
# `--mount=type=cache` is BuildKit state and dies with the same prune, which is
# the failure this image exists to avoid: a measured restore went from 15s to
# 3.13min with four 100s timeouts once nuget.org throttled repeat downloads.
FROM mcr.microsoft.com/dotnet/sdk:10.0
WORKDIR /src
COPY services/orders/Orders.sln ./services/orders/
COPY services/orders/src/Orders.Domain/Orders.Domain.csproj ./services/orders/src/Orders.Domain/
COPY services/orders/src/Orders.Application/Orders.Application.csproj ./services/orders/src/Orders.Application/
COPY services/orders/src/Orders.Infrastructure/Orders.Infrastructure.csproj ./services/orders/src/Orders.Infrastructure/
COPY services/orders/src/Orders.Api/Orders.Api.csproj ./services/orders/src/Orders.Api/
COPY proto ./proto
RUN dotnet restore services/orders/src/Orders.Api/Orders.Api.csproj
