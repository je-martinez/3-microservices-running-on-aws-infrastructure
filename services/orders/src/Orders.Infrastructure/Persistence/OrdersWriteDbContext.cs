using Microsoft.EntityFrameworkCore;
using Orders.Domain.Entities;
using Orders.Infrastructure.Persistence.Configurations;

namespace Orders.Infrastructure.Persistence;

public class OrdersWriteDbContext : DbContext
{
    public OrdersWriteDbContext(DbContextOptions<OrdersWriteDbContext> options) : base(options) { }

    public DbSet<Product> Products => Set<Product>();
    public DbSet<Order> Orders => Set<Order>();
    public DbSet<OrderDetail> OrderDetails => Set<OrderDetail>();
    public DbSet<Configuration> Configurations => Set<Configuration>();

    // Register the audit interceptor here (rather than only at the DI call site)
    // so every construction path — the Program.cs DI, the design-time factory, and
    // the test contexts that `new` this directly — stamps the audit columns
    // consistently. AddInterceptors is idempotent for the same instance, so
    // callers that also add it via options do not double-stamp.
    protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
    {
        optionsBuilder.AddInterceptors(new AuditInterceptor(), new ForUpdateInterceptor());
    }

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.ApplyConfiguration(new ProductConfiguration());
        modelBuilder.ApplyConfiguration(new OrderConfiguration());
        modelBuilder.ApplyConfiguration(new OrderDetailConfiguration());
        modelBuilder.ApplyConfiguration(new ConfigurationConfiguration());
    }
}
