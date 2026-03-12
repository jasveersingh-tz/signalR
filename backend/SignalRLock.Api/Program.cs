using Microsoft.AspNetCore.SignalR;
using StackExchange.Redis;
using SignalRLock.Api.Hubs;
using SignalRLock.Api.Services;

var builder = WebApplication.CreateBuilder(args);

// ── Configuration ────────────────────────────────────────────────────────────
builder.Services.Configure<LockStoreOptions>(builder.Configuration.GetSection("LockStore"));

// ── Redis Connection ─────────────────────────────────────────────────────────
var redisConnection = builder.Configuration.GetValue<string>("Redis:Connection") ?? "localhost:6379";
var redis = ConnectionMultiplexer.Connect(redisConnection);
builder.Services.AddSingleton<IConnectionMultiplexer>(redis);

// ── Services ─────────────────────────────────────────────────────────────────
builder.Services.AddSingleton<ILockStore, RedisLockStore>();
builder.Services.AddControllers();
builder.Services.AddSignalR();

// ── CORS — allow the Angular dev server ──────────────────────────────────────
builder.Services.AddCors(options =>
{
    options.AddPolicy("AngularDev", policy =>
    {
        policy
            .WithOrigins(
                "http://localhost:4100",
                "https://localhost:4100")
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
