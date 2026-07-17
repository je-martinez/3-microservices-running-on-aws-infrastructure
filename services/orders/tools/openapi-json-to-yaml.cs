// Build-time converter: reads the OpenAPI JSON emitted by
// Microsoft.Extensions.ApiDescription.Server and writes the committed
// services/orders/openapi.yaml (OpenAPI 3.1) that is imported into Datadog.
//
// The build-time document generator only emits JSON, so this .NET 10 file-based
// app (invoked from Orders.Api.csproj after GenerateOpenApiDocuments) re-serializes
// it as YAML 3.1. Kept off the runtime dependency graph — it is build tooling only,
// so it can pin a patched Microsoft.OpenApi independent of the service's packages.
//
// Usage: dotnet run --file openapi-json-to-yaml.cs -- <input.json> <output.yaml>
#:package Microsoft.OpenApi@2.10.0
using Microsoft.OpenApi;

if (args.Length != 2)
{
    Console.Error.WriteLine("Usage: openapi-json-to-yaml <input.json> <output.yaml>");
    return 1;
}

var jsonPath = args[0];
var yamlPath = args[1];

await using (var input = File.OpenRead(jsonPath))
{
    var result = await OpenApiDocument.LoadAsync(input, "json");
    var document = result.Document
        ?? throw new InvalidOperationException($"Failed to parse OpenAPI document: {jsonPath}");

    await using var output = File.Create(yamlPath);
    await using var writer = new StreamWriter(output);
    document.SerializeAsV31(new OpenApiYamlWriter(writer));
    await writer.FlushAsync();
}

Console.WriteLine($"Wrote {yamlPath}");
return 0;
