using Microsoft.AspNetCore.SignalR;
using SignalRLock.Api.Hubs;
using SignalRLock.Api.Services;

var builder = WebApplication.CreateBuilder(args);

// ── Configuration ────────────────────────────────────────────────────────────
builder.Services.Configure<LockStoreOptions>(builder.Configuration.GetSection("LockStore"));

// ── Services ─────────────────────────────────────────────────────────────────
builder.Services.AddSingleton<ILockStore, InMemoryLockStore>();
builder.Services.AddControllers();
builder.Services.AddSignalR();

// ── CORS — allow the Angular dev server ──────────────────────────────────────
builder.Services.AddCors(options =>
{
    options.AddPolicy("AngularDev", policy =>
    {
        policy
            .WithOrigins(
                "http://localhost:4200",
                "https://localhost:4200")
            .AllowAnyHeader()
            .AllowAnyMethod()
            .AllowCredentials(); // Required for SignalR WebSockets with credentials
    });
});

var app = builder.Build();

// Inject IHubContext into the static property used by grace-period broadcasts
var hubContext = app.Services.GetRequiredService<IHubContext<RecordLockHub>>();
RecordLockHub.HubContext = hubContext;

// ── Middleware pipeline ───────────────────────────────────────────────────────
app.UseCors("AngularDev");
app.UseRouting();
app.MapControllers();
app.MapHub<RecordLockHub>("/hubs/recordLock");

app.Run();

// Required for integration tests
public partial class Program { }
