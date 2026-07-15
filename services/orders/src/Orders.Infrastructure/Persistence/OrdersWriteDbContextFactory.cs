using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace Orders.Infrastructure.Persistence;

// Design-time factory used only by `dotnet ef` to scaffold migrations. It uses a
// fixed MySqlServerVersion and a placeholder connection string so no live DB is
// required to generate the migration.
public class OrdersWriteDbContextFactory : IDesignTimeDbContextFactory<OrdersWriteDbContext>
{
    public OrdersWriteDbContext CreateDbContext(string[] args)
    {
        var options = new DbContextOptionsBuilder<OrdersWriteDbContext>()
            .UseMySql(
                "Server=localhost;Port=3306;Database=orders;User=root;Password=placeholder;",
                new MySqlServerVersion(new Version(8, 0, 36)))
            .Options;
        return new OrdersWriteDbContext(options);
    }
}
