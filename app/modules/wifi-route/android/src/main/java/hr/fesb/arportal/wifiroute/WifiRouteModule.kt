package hr.fesb.arportal.wifiroute

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.util.Log
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.Inet4Address

/**
 * Keeps the app's network connections on Wi-Fi.
 *
 * The localization server lives on the local Wi-Fi network. Android sends an app's
 * connections over the phone's DEFAULT network, and that is mobile data - although Wi-Fi
 * is connected - whenever the Wi-Fi has no internet access (a router without an uplink)
 * or the phone considers it poor. Requests to a local address then leave over mobile data
 * and never arrive. So the module asks for the Wi-Fi network explicitly and binds the
 * whole process to it for as long as it exists.
 *
 * Process-wide binding is enough because the app talks to nothing but the local server.
 * A provider that needs the internet (a cloud service) would have to bind per connection.
 */
class WifiRouteModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val connectivity: ConnectivityManager
    get() = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

  @Volatile private var wifiNetwork: Network? = null
  @Volatile private var bound = false
  private var callback: ConnectivityManager.NetworkCallback? = null

  override fun definition() = ModuleDefinition {
    Name("WifiRoute")

    // Idempotent. Returns false when the request could not be registered.
    Function("start") { start() }

    Function("getState") { state() }

    OnDestroy { stop() }
  }

  private fun start(): Boolean {
    if (callback != null) {
      return true
    }
    val manager = connectivity
    // No INTERNET capability: a Wi-Fi network without internet access must match too.
    val request = NetworkRequest.Builder()
      .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
      .build()
    val networkCallback = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        wifiNetwork = network
        bound = try {
          manager.bindProcessToNetwork(network)
        } catch (error: Exception) {
          Log.w(TAG, "bindProcessToNetwork failed", error)
          false
        }
        Log.i(TAG, "Wi-Fi network $network available, process bound: $bound")
      }

      override fun onLost(network: Network) {
        if (network == wifiNetwork) {
          wifiNetwork = null
          bound = false
          try {
            manager.bindProcessToNetwork(null)
          } catch (error: Exception) {
            Log.w(TAG, "unbinding failed", error)
          }
          Log.i(TAG, "Wi-Fi network $network lost, process unbound")
        }
      }
    }
    return try {
      manager.requestNetwork(request, networkCallback)
      callback = networkCallback
      true
    } catch (error: Exception) {
      Log.w(TAG, "requestNetwork failed", error)
      false
    }
  }

  private fun stop() {
    val networkCallback = callback ?: return
    callback = null
    try {
      val manager = connectivity
      manager.unregisterNetworkCallback(networkCallback)
      manager.bindProcessToNetwork(null)
    } catch (error: Exception) {
      Log.w(TAG, "stopping failed", error)
    }
    wifiNetwork = null
    bound = false
  }

  private fun state(): Map<String, Any?> {
    val manager = connectivity
    val wifi = wifiNetwork ?: findWifiNetwork(manager)
    val address = wifi?.let { ipv4Address(manager.getLinkProperties(it)) }
    val defaultCapabilities = manager.activeNetwork?.let { manager.getNetworkCapabilities(it) }
    val defaultNetwork = when {
      defaultCapabilities == null -> "none"
      defaultCapabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
      defaultCapabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
      else -> "other"
    }
    return mapOf(
      "wifiConnected" to (wifi != null),
      "address" to address,
      "boundToWifi" to (bound && manager.boundNetworkForProcess != null),
      "defaultNetwork" to defaultNetwork
    )
  }

  /** Before the callback has fired: look through the networks the app may see. */
  @Suppress("DEPRECATION")
  private fun findWifiNetwork(manager: ConnectivityManager): Network? =
    manager.allNetworks.firstOrNull { network ->
      manager.getNetworkCapabilities(network)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
    }

  private fun ipv4Address(properties: LinkProperties?): String? =
    properties?.linkAddresses
      ?.map { it.address }
      ?.filterIsInstance<Inet4Address>()
      ?.firstOrNull { !it.isLoopbackAddress && !it.isLinkLocalAddress }
      ?.hostAddress

  companion object {
    private const val TAG = "WifiRoute"
  }
}
