using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Orders.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddCart : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "cart",
                columns: table => new
                {
                    id = table.Column<string>(type: "varchar(28)", maxLength: 28, nullable: false)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    user_id = table.Column<string>(type: "varchar(28)", maxLength: 28, nullable: false)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    cognito_sub = table.Column<string>(type: "varchar(255)", maxLength: 255, nullable: false)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    active_user_id = table.Column<string>(type: "varchar(28)", maxLength: 28, nullable: true, computedColumnSql: "(CASE WHEN `deleted_at` IS NULL THEN `user_id` ELSE NULL END)", stored: true)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    created_by = table.Column<string>(type: "varchar(28)", maxLength: 28, nullable: true)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    created_at = table.Column<DateTime>(type: "datetime(6)", nullable: false),
                    updated_by = table.Column<string>(type: "varchar(28)", maxLength: 28, nullable: true)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    updated_at = table.Column<DateTime>(type: "datetime(6)", nullable: false),
                    deleted_by = table.Column<string>(type: "varchar(28)", maxLength: 28, nullable: true)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    deleted_at = table.Column<DateTime>(type: "datetime(6)", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_cart", x => x.id);
                })
                .Annotation("MySql:CharSet", "utf8mb4");

            migrationBuilder.CreateTable(
                name: "cart_item",
                columns: table => new
                {
                    id = table.Column<string>(type: "varchar(28)", maxLength: 28, nullable: false)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    cart_id = table.Column<string>(type: "varchar(28)", maxLength: 28, nullable: false)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    product_id = table.Column<string>(type: "varchar(28)", maxLength: 28, nullable: false)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    quantity = table.Column<uint>(type: "int unsigned", nullable: false),
                    active_cart_id = table.Column<string>(type: "varchar(28)", maxLength: 28, nullable: true, computedColumnSql: "(CASE WHEN `deleted_at` IS NULL THEN `cart_id` ELSE NULL END)", stored: true)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    created_by = table.Column<string>(type: "varchar(28)", maxLength: 28, nullable: true)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    created_at = table.Column<DateTime>(type: "datetime(6)", nullable: false),
                    updated_by = table.Column<string>(type: "varchar(28)", maxLength: 28, nullable: true)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    updated_at = table.Column<DateTime>(type: "datetime(6)", nullable: false),
                    deleted_by = table.Column<string>(type: "varchar(28)", maxLength: 28, nullable: true)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    deleted_at = table.Column<DateTime>(type: "datetime(6)", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_cart_item", x => x.id);
                    table.ForeignKey(
                        name: "FK_cart_item_cart_cart_id",
                        column: x => x.cart_id,
                        principalTable: "cart",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                })
                .Annotation("MySql:CharSet", "utf8mb4");

            migrationBuilder.CreateIndex(
                name: "idx_cart_cognito_sub",
                table: "cart",
                column: "cognito_sub");

            migrationBuilder.CreateIndex(
                name: "idx_cart_deleted_at",
                table: "cart",
                column: "deleted_at");

            migrationBuilder.CreateIndex(
                name: "uq_cart_active_user_id",
                table: "cart",
                column: "active_user_id",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "idx_cart_item_deleted_at",
                table: "cart_item",
                column: "deleted_at");

            migrationBuilder.CreateIndex(
                name: "IX_cart_item_cart_id",
                table: "cart_item",
                column: "cart_id");

            migrationBuilder.CreateIndex(
                name: "uq_cart_item_active_cart_product",
                table: "cart_item",
                columns: new[] { "active_cart_id", "product_id" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "cart_item");

            migrationBuilder.DropTable(
                name: "cart");
        }
    }
}
