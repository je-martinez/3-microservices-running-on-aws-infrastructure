# Orders service — .NET Core 10 Minimal API, Clean Architecture solution.
# Build context: REPO ROOT — the shared gRPC contract proto/users.proto lives
# there and Grpc.Tools generates the Users client from it at build time (it is
# outside services/orders, so a service-scoped context could not see it).
# Multi-stage: sdk restores + publishes src/Orders.Api; aspnet runs the DLL.

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

# Grpc.Tools' bundled protoc segfaults (SIGSEGV) on this Ubuntu 24.04 arm64 base
# image; the OS protoc runs fine. Install it and point Grpc.Tools at it via
# Protobuf_ProtocFullPath — Grpc.Tools still supplies grpc_csharp_plugin (a
# separate binary that does NOT crash), so codegen stays at build time.
RUN apt-get update \
    && apt-get install -y --no-install-recommends protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*
ENV Protobuf_ProtocFullPath=/usr/bin/protoc

# Restore first (layer caching): copy the solution + every csproj, then restore.
COPY services/orders/Orders.sln ./services/orders/
COPY services/orders/src/Orders.Domain/Orders.Domain.csproj ./services/orders/src/Orders.Domain/
COPY services/orders/src/Orders.Application/Orders.Application.csproj ./services/orders/src/Orders.Application/
COPY services/orders/src/Orders.Infrastructure/Orders.Infrastructure.csproj ./services/orders/src/Orders.Infrastructure/
COPY services/orders/src/Orders.Api/Orders.Api.csproj ./services/orders/src/Orders.Api/
# The shared proto is referenced by Orders.Infrastructure.csproj (../../../../proto).
COPY proto ./proto
RUN dotnet restore services/orders/src/Orders.Api/Orders.Api.csproj

# Copy the rest of the sources and publish (Api pulls in Application + Infrastructure).
COPY services/orders/src ./services/orders/src
RUN dotnet publish services/orders/src/Orders.Api/Orders.Api.csproj -c Release -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app
COPY --from=build /app/publish ./
EXPOSE 8080
ENV ASPNETCORE_URLS=http://+:8080
ENTRYPOINT ["dotnet", "Orders.Api.dll"]
