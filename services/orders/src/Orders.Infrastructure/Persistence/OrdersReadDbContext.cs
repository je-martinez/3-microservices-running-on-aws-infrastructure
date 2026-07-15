using Microsoft.EntityFrameworkCore;
using Orders.Domain.Entities;
using Orders.Infrastructure.Persistence.Configurations;

namespace Orders.Infrastructure.Persistence;

// Read-only context (read replica in prod; same MySQL locally). Queries should
// use AsNoTracking; writes never go through this context.
public class OrdersReadDbContext : DbContext
{
    public OrdersReadDbContext(DbContextOptions<OrdersReadDbContext> options) : base(options) { }

    public DbSet<Product> Products => Set<Product>();
    public DbSet<Order> Orders => Set<Order>();
    public DbSet<OrderDetail> OrderDetails => Set<OrderDetail>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.ApplyConfiguration(new ProductConfiguration());
        modelBuilder.ApplyConfiguration(new OrderConfiguration());
        modelBuilder.ApplyConfiguration(new OrderDetailConfiguration());
    }
}
