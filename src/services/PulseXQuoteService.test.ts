import { ethers } from "ethers";
import config from "../config";
import { PulseXQuoteService } from "./PulseXQuoteService";
import { Route } from "../types/Quote";

afterEach(() => {
  jest.restoreAllMocks();
});

describe("PulseXQuoteService WPLS normalization", () => {
  const createRoute = (): Route => ({
    paths: [],
    swaps: [],
  });
  const dummyProvider = new ethers.JsonRpcProvider("http://localhost:8545");

  it("bridges through WPLS when direct route is missing", async () => {
    const service = new PulseXQuoteService(dummyProvider);
    const tokenInToWplsRoute = createRoute();
    const wplsToTokenOutRoute = createRoute();
    const combinedRoute = createRoute();

    const findDirectRouteMock = jest
      .spyOn<any, any>(service as any, "findDirectRoute")
      .mockResolvedValueOnce(tokenInToWplsRoute)
      .mockResolvedValueOnce(wplsToTokenOutRoute);

    const getAmountOutMock = jest
      .spyOn<any, any>(service as any, "getAmountOut")
      .mockResolvedValue("123");

    const combineRoutesMock = jest
      .spyOn<any, any>(service as any, "combineRoutes")
      .mockReturnValue(combinedRoute);

    const result = await (service as any).findRouteThroughPLS(
      "0xTokenIn",
      "0xTokenOut",
      "1000"
    );

    expect(findDirectRouteMock).toHaveBeenNthCalledWith(
      1,
      "0xTokenIn",
      config.WPLS,
      "1000"
    );
    expect(getAmountOutMock).toHaveBeenCalledWith(
      "0xTokenIn",
      config.WPLS,
      "1000",
      tokenInToWplsRoute
    );
    expect(findDirectRouteMock).toHaveBeenNthCalledWith(
      2,
      config.WPLS,
      "0xTokenOut",
      "123"
    );
    expect(combineRoutesMock).toHaveBeenCalledWith(
      tokenInToWplsRoute,
      wplsToTokenOutRoute
    );
    expect(result).toBe(combinedRoute);
  });

  it("normalizes native tokens to WPLS for router amount checks", async () => {
    const service = new PulseXQuoteService(dummyProvider);

    const pulsexV2Router = {
      getAmountsOut: jest.fn().mockResolvedValue([BigInt(1), BigInt(200)]),
    };

    const pulsexV1Router = {
      getAmountsOut: jest.fn(),
    };

    (service as any).pulsexV2Router = pulsexV2Router;
    (service as any).pulsexV1Router = pulsexV1Router;

    const amount = await (service as any).getAmountOut(
      ethers.ZeroAddress,
      "0xTokenOut",
      "1000",
      createRoute()
    );

    expect(pulsexV2Router.getAmountsOut).toHaveBeenCalledWith("1000", [
      config.WPLS,
      "0xTokenOut",
    ]);
    expect(pulsexV1Router.getAmountsOut).not.toHaveBeenCalled();
    expect(amount).toBe("200");
  });

  it("formats native token input as zero address in the response", async () => {
    const service = new PulseXQuoteService(dummyProvider);
    const TOKEN_OUT = "0x0000000000000000000000000000000000000011";
    const PAIR = "0x00000000000000000000000000000000000000aa";
    const route: Route = {
      paths: [
        [
          { address: config.WPLS, symbol: "WPLS", decimals: 18, chainId: 369 },
          { address: TOKEN_OUT, symbol: "TOUT", decimals: 18, chainId: 369 },
        ],
      ],
      swaps: [
        {
          percent: 100000,
          subswaps: [
            {
              percent: 100000,
              paths: [
                { percent: 100000, address: PAIR, exchange: "PulseX V2" },
              ],
            },
          ],
        },
      ],
    };

    jest
      .spyOn<any, any>(service as any, "calculateRouteOutput")
      .mockResolvedValue("200");
    jest
      .spyOn<any, any>(service as any, "estimateGas")
      .mockResolvedValue({ gasAmount: 100000, gasUSD: 1 });

    const response = await (service as any).transformToQuoteResponse(
      route,
      {
        tokenInAddress: config.WPLS,
        tokenOutAddress: TOKEN_OUT,
        amount: "1000",
      },
      false,
      "PLS",
      TOKEN_OUT
    );

    expect(response.tokenInAddress).toBe(ethers.ZeroAddress);
    expect(response.tokenOutAddress).toBe(TOKEN_OUT);
  });

  it("formats native token output as zero address in the response", async () => {
    const service = new PulseXQuoteService(dummyProvider);
    const TOKEN_IN = "0x0000000000000000000000000000000000000005";
    const PAIR = "0x00000000000000000000000000000000000000bb";
    const route: Route = {
      paths: [
        [
          { address: TOKEN_IN, symbol: "TIN", decimals: 18, chainId: 369 },
          { address: config.WPLS, symbol: "WPLS", decimals: 18, chainId: 369 },
        ],
      ],
      swaps: [
        {
          percent: 100000,
          subswaps: [
            {
              percent: 100000,
              paths: [
                { percent: 100000, address: PAIR, exchange: "PulseX V2" },
              ],
            },
          ],
        },
      ],
    };

    jest
      .spyOn<any, any>(service as any, "calculateRouteOutput")
      .mockResolvedValue("200");
    jest
      .spyOn<any, any>(service as any, "estimateGas")
      .mockResolvedValue({ gasAmount: 100000, gasUSD: 1 });

    const response = await (service as any).transformToQuoteResponse(
      route,
      {
        tokenInAddress: TOKEN_IN,
        tokenOutAddress: config.WPLS,
        amount: "1000",
      },
      true,
      TOKEN_IN,
      "PLS"
    );

    expect(response.tokenInAddress).toBe(TOKEN_IN);
    expect(response.tokenOutAddress).toBe(ethers.ZeroAddress);
  });
});
