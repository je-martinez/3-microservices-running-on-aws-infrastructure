using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Orders.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddStripePaymentSnapshot : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<long>(
                name: "amount_cents",
                table: "order",
                type: "bigint",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "card_brand",
                table: "order",
                type: "varchar(32)",
                maxLength: 32,
                nullable: true)
                .Annotation("MySql:CharSet", "utf8mb4");

            migrationBuilder.AddColumn<int>(
                name: "card_exp_month",
                table: "order",
                type: "int",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "card_exp_year",
                table: "order",
                type: "int",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "card_last4",
                table: "order",
                type: "char(4)",
                nullable: true)
                .Annotation("MySql:CharSet", "utf8mb4");

            migrationBuilder.AddColumn<string>(
                name: "currency",
                table: "order",
                type: "char(3)",
                nullable: true)
                .Annotation("MySql:CharSet", "utf8mb4");

            migrationBuilder.AddColumn<string>(
                name: "payment_intent_id",
                table: "order",
                type: "varchar(255)",
                maxLength: 255,
                nullable: true)
                .Annotation("MySql:CharSet", "utf8mb4");

            migrationBuilder.AddColumn<string>(
                name: "payment_method_id",
                table: "order",
                type: "varchar(255)",
                maxLength: 255,
                nullable: true)
                .Annotation("MySql:CharSet", "utf8mb4");

            migrationBuilder.AddColumn<string>(
                name: "payment_raw_payload",
                table: "order",
                type: "json",
                nullable: true)
                .Annotation("MySql:CharSet", "utf8mb4");

            migrationBuilder.AddColumn<string>(
                name: "payment_status",
                table: "order",
                type: "varchar(64)",
                maxLength: 64,
                nullable: true)
                .Annotation("MySql:CharSet", "utf8mb4");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "amount_cents",
                table: "order");

            migrationBuilder.DropColumn(
                name: "card_brand",
                table: "order");

            migrationBuilder.DropColumn(
                name: "card_exp_month",
                table: "order");

            migrationBuilder.DropColumn(
                name: "card_exp_year",
                table: "order");

            migrationBuilder.DropColumn(
                name: "card_last4",
                table: "order");

            migrationBuilder.DropColumn(
                name: "currency",
                table: "order");

            migrationBuilder.DropColumn(
                name: "payment_intent_id",
                table: "order");

            migrationBuilder.DropColumn(
                name: "payment_method_id",
                table: "order");

            migrationBuilder.DropColumn(
                name: "payment_raw_payload",
                table: "order");

            migrationBuilder.DropColumn(
                name: "payment_status",
                table: "order");
        }
    }
}
