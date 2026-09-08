using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Orders.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddOrderNumber : Migration
    {
        /// <summary>
        /// Adds the customer-facing order number, backfills existing rows, then adds the
        /// unique index.
        /// </summary>
        /// <remarks>
        /// CONTRACT: The three steps are ORDERED. The index goes on LAST — created first, the
        /// migration aborts halfway on any duplicate, leaving some orders numbered and some
        /// not.
        /// CONTRACT: The backfill's date rule is byte-identical to <c>OrderNumber.New</c>, or
        /// backfilled and minted numbers disagree on which orders share a day.
        /// See [[friendly-order-number]]
        /// </remarks>
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "order_number",
                table: "order",
                type: "char(12)",
                nullable: true)
                .Annotation("MySql:CharSet", "utf8mb4");

            // CONTRACT: The alphabet here MUST stay byte-identical to
            // OrderNumberConfig.Alphabet. A constant cannot cross the C#/SQL boundary, so
            // OrderNumberTests pins the two against each other instead.
            //
            // WHY: RAND() per character, not a hash of the id — a hash collides
            // deterministically, so the index build below would fail identically on re-run.
            // Soft-deleted rows are included: support still reads them.
            // See [[friendly-order-number]]
            migrationBuilder.Sql(
                """
                UPDATE `order`
                SET `order_number` = CONCAT(
                    DATE_FORMAT(`created_at`, '%y%m%d'),
                    SUBSTRING('0123456789ABCDEFGHJKMNPQRSTVWXYZ', FLOOR(RAND() * 32) + 1, 1),
                    SUBSTRING('0123456789ABCDEFGHJKMNPQRSTVWXYZ', FLOOR(RAND() * 32) + 1, 1),
                    SUBSTRING('0123456789ABCDEFGHJKMNPQRSTVWXYZ', FLOOR(RAND() * 32) + 1, 1),
                    SUBSTRING('0123456789ABCDEFGHJKMNPQRSTVWXYZ', FLOOR(RAND() * 32) + 1, 1),
                    SUBSTRING('0123456789ABCDEFGHJKMNPQRSTVWXYZ', FLOOR(RAND() * 32) + 1, 1),
                    SUBSTRING('0123456789ABCDEFGHJKMNPQRSTVWXYZ', FLOOR(RAND() * 32) + 1, 1))
                WHERE `order_number` IS NULL;
                """);

            // WARNING: This build FAILS if the backfill drew the same number twice for one
            // day. That is the correct outcome — it means duplicates exist and must not be
            // indexed away silently. Re-running the UPDATE above (it is scoped to NULLs, so
            // re-run it after clearing the offending rows) redraws them.
            migrationBuilder.CreateIndex(
                name: "ux_order_order_number",
                table: "order",
                column: "order_number",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "ux_order_order_number",
                table: "order");

            migrationBuilder.DropColumn(
                name: "order_number",
                table: "order");
        }
    }
}
